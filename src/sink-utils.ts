/**
 * Shared machinery of the part-uploading sinks (S3, …): a bounded
 * per-session event buffer, the flush triggers (`session/flush`, `batchSize`,
 * `session/disposed`, drain on close), serialized per-session upload queues,
 * exponential-backoff retry, and the local dead-letter fallback.
 *
 * A concrete sink supplies only the transport: how one serialized JSONL part
 * is uploaded ({@link BufferedPartSink.uploadPart}), how a part is named in
 * log lines ({@link BufferedPartSink.partName}), and how the transport is
 * released after the final drain ({@link BufferedPartSink.release}).
 *
 * @module dsh-trajectory-persistence/sink-utils
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { encodeSegment, projectKey, serializePart } from './jsonl.js'
import { withRetry } from './retry.js'

/**
 * Bounded per-session event buffer with ring (drop-oldest) overflow semantics.
 * Flushes are normally triggered at `batchSize`, long before the cap; the cap
 * bounds memory when uploads stall.
 */
export class EventBuffer {
  private items: SessionEvent[] = []
  /** Events dropped because the buffer overflowed. */
  dropped = 0

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`EventBuffer capacity must be a positive integer, got ${String(capacity)}`)
    }
  }

  get size(): number {
    return this.items.length
  }

  /** Append one event, evicting the oldest when at capacity. */
  push(event: SessionEvent): void {
    if (this.items.length >= this.capacity) {
      this.items.shift()
      this.dropped++
    }
    this.items.push(event)
  }

  /** Remove and return up to `n` oldest events. */
  take(n: number): SessionEvent[] {
    return this.items.splice(0, n)
  }

  /** Remove and return everything buffered. */
  takeAll(): SessionEvent[] {
    return this.items.splice(0)
  }
}

/** The buffering/retry/dead-letter settings every part-uploading sink shares. */
export interface PartSinkLimits {
  /** Flush a session's buffer once it holds at least this many events. */
  batchSize: number
  /** Upper bound of buffered events per session; oldest events are dropped (with a warning) beyond it. */
  maxBufferedEvents: number
  /** Retries after the first upload attempt (exponential backoff). */
  maxRetries: number
  /** Base backoff delay in milliseconds. */
  retryBaseDelayMs: number
  /** Local directory receiving parts whose upload finally failed (dead letter). */
  deadLetterDir: string
}

interface SessionState {
  header: SessionHeader
  buffer: EventBuffer
  /** Serializes this session's uploads, preserving seq order across parts. */
  queue: Promise<void>
  retired: boolean
}

/** Point-in-time counters of one part-uploading sink, surfaced by `/trajectory-status`. */
export interface PartSinkStats {
  /** Parts uploaded successfully. */
  uploadedParts: number
  /** Parts whose upload failed permanently (dead-lettered or dropped). */
  deadLetteredParts: number
  /** Events dropped by buffer overflow, summed across all sessions. */
  droppedEvents: number
  /** Sessions currently tracked. */
  sessions: number
  /** Events currently buffered across all sessions. */
  bufferedEvents: number
  /** Epoch milliseconds of the last successful upload. */
  lastUploadAt?: number
  /** Message of the most recent permanent failure. */
  lastError?: string
}

/**
 * Base class of the part-uploading sinks. Every session's live event stream
 * is buffered in memory (bounded ring) and uploaded as JSONL part files —
 * header line + one event per line, compatible with the
 * `dsh-session-persistence-jsonl` artifact layout. Uploads retry with
 * exponential backoff; a part whose upload finally fails is written to the
 * local dead-letter directory instead.
 */
export abstract class BufferedPartSink {
  private readonly sessions = new Map<Session, SessionState>()
  private readonly logger
  /** Set by close(); later session callbacks are dropped (with one warning). */
  private closed = false
  private closedWarned = false
  private uploadedParts = 0
  private deadLetteredParts = 0
  private droppedEvents = 0
  private lastUploadAt?: number
  private lastError?: string

  constructor(
    ctx: Context,
    private readonly limits: PartSinkLimits,
    /** Sink kind used in logger and error messages (e.g. `s3`). */
    kind: string,
  ) {
    if (!Number.isInteger(limits.batchSize) || limits.batchSize < 1) {
      throw new Error(
        `${kind} sink: batchSize must be a positive integer, got ${String(limits.batchSize)}`,
      )
    }
    if (limits.batchSize > limits.maxBufferedEvents) {
      throw new Error(
        `${kind} sink: batchSize (${limits.batchSize}) must not exceed maxBufferedEvents (${limits.maxBufferedEvents})`,
      )
    }
    this.logger = ctx.logger(`dsh-trajectory-persistence/${kind}`)
  }

  /** Upload one serialized JSONL part; must reject on failure (the base class retries). */
  protected abstract uploadPart(
    header: SessionHeader,
    seqStart: number,
    seqEnd: number,
    body: string,
  ): Promise<void>

  /** Short identifier of one part for log lines (object key, file name, …). */
  protected abstract partName(header: SessionHeader, seqStart: number, seqEnd: number): string

  /** Release the transport after the final drain. Awaited by close(). */
  protected abstract release(): Promise<void>

  /** Record the session header so later flushes can write header lines. */
  sessionCreated(session: Session): void {
    if (this.warnIfClosed()) return
    this.stateOf(session)
  }

  /** Buffer one event; flush when the batch-size trigger trips. */
  onEvent(session: Session, event: SessionEvent): void {
    if (this.warnIfClosed()) return
    const state = this.stateOf(session)
    if (state.retired) return
    const droppedBefore = state.buffer.dropped
    state.buffer.push(event)
    this.droppedEvents += state.buffer.dropped - droppedBefore
    if (state.buffer.dropped > 0 && state.buffer.dropped % 100 === 1) {
      this.logger.warn(
        `session ${session.id}: buffer overflow dropped ${state.buffer.dropped} events (uploads stalled?)`,
      )
    }
    if (state.buffer.size >= this.limits.batchSize) {
      this.enqueueFlush(state)
    }
  }

  /**
   * `session/flush` durability checkpoint: upload everything buffered for this
   * session. Returns a promise that settles once the queued uploads (and any
   * dead-letter fallbacks) complete, so the harness's awaited checkpoint
   * actually means "the trajectory left the process". Never rejects.
   */
  onFlush(session: Session): Promise<void> | undefined {
    if (this.warnIfClosed()) return undefined
    const state = this.sessions.get(session)
    if (!state || state.retired) return undefined
    this.enqueueFlush(state)
    return state.queue
  }

  /** `session/disposed`: final flush, then retire the session state. */
  onDisposed(session: Session): void {
    if (this.warnIfClosed()) return
    const state = this.sessions.get(session)
    if (!state) return
    state.retired = true
    this.enqueueFlush(state)
    state.queue = state.queue.then(() => {
      this.sessions.delete(session)
    })
  }

  /** Drain all sessions and release the transport. Awaited at plugin dispose. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.flushAllSessions()
      await Promise.allSettled([...this.sessions.values()].map(state => state.queue))
    } finally {
      await this.release()
    }
  }

  /** Read-only snapshot of this sink's counters, for status reporting. */
  stats(): PartSinkStats {
    let bufferedEvents = 0
    for (const state of this.sessions.values()) bufferedEvents += state.buffer.size
    return {
      uploadedParts: this.uploadedParts,
      deadLetteredParts: this.deadLetteredParts,
      droppedEvents: this.droppedEvents,
      sessions: this.sessions.size,
      bufferedEvents,
      lastUploadAt: this.lastUploadAt,
      lastError: this.lastError,
    }
  }

  /** Enqueue a flush of every tracked session's buffer (periodic flush, drain on close). */
  protected flushAllSessions(): void {
    for (const state of this.sessions.values()) {
      this.enqueueFlush(state)
    }
  }

  /** After close(), session callbacks are dropped; warn only on the first one. */
  private warnIfClosed(): boolean {
    if (!this.closed) return false
    if (!this.closedWarned) {
      this.closedWarned = true
      this.logger.warn('sink is closed, dropping session activity')
    }
    return true
  }

  private stateOf(session: Session): SessionState {
    let state = this.sessions.get(session)
    if (!state) {
      state = {
        header: session.header,
        buffer: new EventBuffer(this.limits.maxBufferedEvents),
        queue: Promise.resolve(),
        retired: false,
      }
      this.sessions.set(session, state)
    }
    return state
  }

  /** Chain one flush onto the session's upload queue; a failed flush must never poison it. */
  private enqueueFlush(state: SessionState): void {
    state.queue = state.queue.catch(() => {}).then(() => this.flushNow(state))
  }

  /** Upload the whole current buffer of one session as part files. Never rejects. */
  private async flushNow(state: SessionState): Promise<void> {
    let batch = state.buffer.take(this.limits.batchSize)
    while (batch.length > 0) {
      try {
        await this.uploadBatch(state.header, batch)
      } catch (error) {
        // Serialization (BigInt, cycles) or any unexpected failure: the batch
        // is already out of the buffer, so log and keep the queue alive.
        this.lastError = String(error)
        this.logger.warn(`flush of ${batch.length} events failed, dropping batch: ${String(error)}`)
      }
      batch = state.buffer.take(this.limits.batchSize)
    }
  }

  private async uploadBatch(header: SessionHeader, batch: SessionEvent[]): Promise<void> {
    const seqStart = batch[0].seq
    const seqEnd = batch[batch.length - 1].seq
    const name = this.partName(header, seqStart, seqEnd)
    const body = serializePart(header, batch)
    try {
      await withRetry(() => this.uploadPart(header, seqStart, seqEnd, body), {
        maxRetries: this.limits.maxRetries,
        baseDelayMs: this.limits.retryBaseDelayMs,
        onRetry: (attempt, error, delayMs) => {
          this.logger.warn(
            `upload ${name} failed (attempt ${attempt}, retry in ${delayMs}ms): ${String(error)}`,
          )
        },
      })
      this.uploadedParts++
      this.lastUploadAt = Date.now()
    } catch (error) {
      this.deadLetteredParts++
      this.lastError = String(error)
      this.logger.warn(`upload ${name} failed permanently, writing dead letter: ${String(error)}`)
      try {
        await this.writeDeadLetter(header, seqStart, seqEnd, body)
      } catch (deadLetterError) {
        this.lastError = String(deadLetterError)
        this.logger.warn(
          `dead-letter write for ${name} failed, dropping part: ${String(deadLetterError)}`,
        )
      }
    }
  }

  private async writeDeadLetter(
    header: SessionHeader,
    seqStart: number,
    seqEnd: number,
    body: string,
  ): Promise<void> {
    const dir = join(this.limits.deadLetterDir, projectKey(header.cwd), encodeSegment(header.id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${seqStart}-${seqEnd}.jsonl`), body, 'utf8')
  }
}
