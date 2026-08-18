/**
 * Ship-mode S3 sink: tails the official `session-persistence-jsonl` backend's
 * on-disk artifacts read-only and ships byte-aligned zstd frame segments to
 * S3. It never subscribes to the live event stream and never re-serializes —
 * complete frames are cut out of the artifact and uploaded as-is, so the torn
 * tail a crash leaves behind never leaves the machine.
 *
 * Layout scanned (two directory levels below `root`):
 *
 *     {root}/{projectDir}/{sessionId}/session.jsonl.zstd
 *
 * Upload layout (shared with `./manifest.js`):
 *
 *     {prefix}/{projectDir}/{sessionId}/{offsetStart}-{offsetEnd}.jsonl.zstd
 *     {prefix}/{projectDir}/{sessionId}/_manifest.json
 *
 * Progress is tracked locally in ship-state (`./ship-state.js`) and
 * authoritatively in the per-session `_manifest.json` watermark: on first
 * contact with a session the manifest wins over the local offset, so a lost
 * or stale state file resumes instead of re-shipping.
 *
 * @module dsh-trajectory-persistence/shipper
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { S3SinkConfig } from './config.js'
import {
  getOrCreateWriterId,
  MANIFEST_VERSION,
  manifestKey,
  readManifest,
  segmentKey,
  updateManifest,
} from './manifest.js'
import type { ManifestSegment, ObjectStore, ShipManifest } from './manifest.js'
import {
  advanceSessionOffset,
  defaultShipStateDir,
  getSessionState,
  initialSessionState,
  loadShipState,
  saveShipState,
  updateSessionState,
} from './ship-state.js'
import type { ShipState } from './ship-state.js'
import { scanZstdFrames } from './zstd-scan.js'
import { withRetry } from './retry.js'

/** Name of the artifact file inside each session directory. */
const ARTIFACT_NAME = 'session.jsonl.zstd'

/** Object store with listing and a release hook — the AWS-backed default owned by the sink. */
export interface S3ObjectStore extends ObjectStore {
  /** List every object key under `prefix` (empty array when none). */
  list(prefix: string): Promise<string[]>
  close(): Promise<void>
}

/** Connection-related subset of {@link S3SinkConfig} the object store needs. */
export type S3ObjectStoreConfig = Pick<
  S3SinkConfig,
  'bucket' | 'region' | 'endpoint' | 'forcePathStyle' | 'credentials'
>

/**
 * Build the default object store backed by `@aws-sdk/client-s3`, mirroring
 * the credential/endpoint resolution of `createS3Uploader` in `./s3-sink.js`.
 * The uploader there only accepts string bodies, so binary segments and
 * manifest reads go through this dedicated store.
 */
export function createS3ObjectStore(config: S3ObjectStoreConfig): S3ObjectStore {
  const client = new S3Client({
    region: config.region,
    ...config.endpoint !== undefined ? { endpoint: config.endpoint } : {},
    ...config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {},
    ...config.credentials !== undefined ? { credentials: config.credentials } : {},
  })
  return {
    async getObject(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        return Buffer.from(await out.Body!.transformToByteArray())
      } catch (error) {
        const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } }
        if (failure.name === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
    async putObject(key, body) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: key.endsWith('.json') ? 'application/json' : 'application/zstd',
      }))
    },
    async list(prefix) {
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const out = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }))
        for (const object of out.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key)
        }
        continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined
      } while (continuationToken !== undefined)
      return keys
    },
    async close() {
      client.destroy()
    },
  }
}

/** Point-in-time counters of the ship-mode sink, surfaced by `/trajectory-status`. */
export interface ShipperStats {
  /** Always `ship` — discriminates against the push-mode `S3SinkStats`. */
  mode: 'ship'
  /** Sessions currently tracked (artifacts discovered under `root`). */
  trackedSessions: number
  /** Tracked sessions currently dormant (artifact stable past dormantAfterMs). */
  dormantSessions: number
  /** Segments uploaded successfully by this sink instance. */
  uploadedSegments: number
  /** Segment bytes uploaded successfully by this sink instance. */
  uploadedBytes: number
  /** Artifact bytes not yet uploaded, summed over non-conflicted sessions. */
  lagBytes: number
  /** `projectDir/sessionId` of sessions whose artifact regressed below the watermark. */
  conflicted: string[]
  /** Epoch milliseconds of the last successful segment upload. */
  lastUploadAt?: number
  /** Message of the most recent failure. */
  lastError?: string
}

/** Runtime tracking record of one discovered artifact (not persisted). */
interface TrackedSession {
  /** Encoded project directory segment (first level under `root`). */
  projectDir: string
  /** Encoded session id segment (second level under `root`). */
  sessionId: string
  /** Absolute artifact path. */
  path: string
  /** False until this instance reconciled the local offset against the manifest. */
  manifestChecked: boolean
  /** Epoch ms when the artifact revision (size+mtime) last changed. */
  unchangedSince: number
  /** Epoch ms when the oldest pending complete frame was first seen. */
  firstPendingAt?: number
  /** One-shot warn latches. */
  warnedForeign: boolean
  warnedConflict: boolean
}

/**
 * Ship-mode S3 sink. The constructor starts an unref'd poll timer; `poll()`
 * is the manually drivable seam (serialized with the timer) used by tests.
 * Session-event callbacks exist only to keep the sink-set surface uniform —
 * they are deliberate no-ops: ship mode does not consume the event stream.
 */
export class S3ShipperSink {
  private readonly logger
  private readonly store: ObjectStore
  private readonly ownsStore: boolean
  private readonly stateDir: string
  private readonly tracked = new Map<string, TrackedSession>()
  private state: ShipState = { version: 1, sessions: {} }
  private writerId = ''
  private timer?: NodeJS.Timeout
  /** Settles once ship-state and the writer id are loaded and the timer runs. */
  private readonly ready: Promise<void>
  /** Serializes poll passes (timer and manual) so offsets never race. */
  private tail: Promise<void> = Promise.resolve()
  private closePromise?: Promise<void>
  private uploadedSegments = 0
  private uploadedBytes = 0
  private lastUploadAt?: number
  private lastError?: string

  constructor(
    ctx: Context,
    private readonly config: S3SinkConfig,
    store?: ObjectStore,
    stateDir?: string,
  ) {
    this.logger = ctx.logger('dsh-trajectory-persistence/s3')
    if (!config.bucket) throw new Error('s3 sink: bucket is required when the s3 sink is enabled')
    if (!config.root) throw new Error('s3 sink: root is required when the s3 sink runs in ship mode')
    this.store = store ?? createS3ObjectStore(config)
    this.ownsStore = store === undefined
    this.stateDir = stateDir ?? defaultShipStateDir()
    this.ready = this.init()
    // poll()/close() still observe init failures through `ready`; this handler
    // only keeps an unobserved init failure from crashing the process.
    this.ready.catch(() => {})
  }

  /** No-op: ship mode tails artifacts on disk, not the live event stream. */
  sessionCreated(_session: Session): void {}
  /** No-op: ship mode tails artifacts on disk, not the live event stream. */
  onEvent(_session: Session, _event: SessionEvent): void {}
  /** No-op: durability is poll-driven; there is no per-session buffer to drain. */
  onFlush(_session: Session): Promise<void> | undefined {
    return undefined
  }
  /** No-op: artifact discovery, not session lifecycle, drives tracking. */
  onDisposed(_session: Session): void {}

  /**
   * Run one poll pass: discover artifacts, observe revisions, and ship due
   * segments. Passes are serialized — a timer tick during a manual poll queues
   * behind it. Rejects only when initialization failed; per-session and
   * per-scan failures are logged and recorded in `stats().lastError`.
   */
  poll(): Promise<void> {
    const run = this.tail.then(() => this.ready).then(() => this.pollOnce(false))
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /**
   * Stop the poll timer, attempt a final flush of every session with pending
   * complete frames, persist ship-state, and release the store. Idempotent.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.timer) clearInterval(this.timer)
    this.closePromise = this.tail
      .then(() => this.ready)
      .then(() => this.pollOnce(true))
      .catch(() => {}) // pollOnce never rejects; the catch guards init failures only
      .finally(async () => {
        try {
          await saveShipState(this.stateDir, this.state)
        } catch (error) {
          this.logger.warn(`persisting ship-state failed: ${String(error)}`)
        }
        if (this.ownsStore) await (this.store as S3ObjectStore).close()
      })
    return this.closePromise
  }

  /** Read-only snapshot of this sink's counters, for status reporting. */
  stats(): ShipperStats {
    let lagBytes = 0
    let dormantSessions = 0
    const conflicted: string[] = []
    for (const tracked of this.tracked.values()) {
      const session = getSessionState(this.state, tracked.sessionId)
      if (!session) continue
      if (session.conflicted) {
        conflicted.push(`${tracked.projectDir}/${tracked.sessionId}`)
        continue
      }
      if (session.dormant) dormantSessions++
      lagBytes += Math.max(0, session.lastSize - session.uploadedOffset)
    }
    return {
      mode: 'ship',
      trackedSessions: this.tracked.size,
      dormantSessions,
      uploadedSegments: this.uploadedSegments,
      uploadedBytes: this.uploadedBytes,
      lagBytes,
      conflicted,
      lastUploadAt: this.lastUploadAt,
      lastError: this.lastError,
    }
  }

  private async init(): Promise<void> {
    this.state = await loadShipState(this.stateDir)
    this.writerId = this.config.writerId ?? await getOrCreateWriterId(this.stateDir)
    this.timer = setInterval(() => {
      this.poll().catch((error: unknown) => {
        this.logger.warn(`poll failed: ${String(error)}`)
      })
    }, this.config.pollIntervalMs)
    this.timer.unref()
  }

  /** One scan+ship pass over the artifact root. Never rejects. */
  private async pollOnce(final: boolean): Promise<void> {
    let discovered: TrackedSession[]
    try {
      discovered = await this.scanRoot()
    } catch (error) {
      this.lastError = String(error)
      this.logger.warn(`scanning ${this.config.root} failed: ${String(error)}`)
      return
    }
    for (const tracked of discovered) {
      try {
        await this.shipSession(tracked, final)
      } catch (error) {
        this.lastError = String(error)
        this.logger.warn(`session ${tracked.sessionId}: poll failed: ${String(error)}`)
      }
    }
    try {
      await saveShipState(this.stateDir, this.state)
    } catch (error) {
      this.lastError = String(error)
      this.logger.warn(`persisting ship-state failed: ${String(error)}`)
    }
  }

  /** List `{projectDir}/{sessionId}/session.jsonl.zstd` artifacts under `root`. */
  private async scanRoot(): Promise<TrackedSession[]> {
    const found: TrackedSession[] = []
    let projects
    try {
      projects = await readdir(this.config.root, { withFileTypes: true })
    } catch (error) {
      // A missing root is normal before the first session lands on disk.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found
      throw error
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      let sessions
      try {
        sessions = await readdir(join(this.config.root, project.name), { withFileTypes: true })
      } catch {
        continue // unreadable project dir: skip, retry next pass
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const path = join(this.config.root, project.name, session.name, ARTIFACT_NAME)
        const key = `${project.name}/${session.name}`
        let tracked = this.tracked.get(key)
        if (!tracked) {
          tracked = {
            projectDir: project.name,
            sessionId: session.name,
            path,
            manifestChecked: false,
            unchangedSince: Date.now(),
            warnedForeign: false,
            warnedConflict: false,
          }
          this.tracked.set(key, tracked)
        }
        found.push(tracked)
      }
    }
    return found
  }

  /** Observe one artifact and ship every due segment of it. */
  private async shipSession(tracked: TrackedSession, final: boolean): Promise<void> {
    let info
    try {
      info = await stat(tracked.path, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // artifact not flushed yet
      throw error
    }
    const size = Number(info.size)
    const mtimeNs = Number(info.mtimeNs)
    const now = Date.now()

    if (!tracked.manifestChecked) {
      tracked.manifestChecked = true
      await this.reconcileWithManifest(tracked)
    }

    const previous = getSessionState(this.state, tracked.sessionId)
    const unchanged = previous !== undefined
      && previous.lastSize === size && previous.lastMtimeNs === mtimeNs
    if (unchanged) {
      tracked.unchangedSince = Math.min(tracked.unchangedSince, now)
    } else {
      tracked.unchangedSince = now
    }
    const dormant = unchanged && now - tracked.unchangedSince >= this.config.dormantAfterMs
    const session = updateSessionState(this.state, tracked.sessionId, { size, mtimeNs, dormant })

    if (session.conflicted) {
      if (!tracked.warnedConflict) {
        tracked.warnedConflict = true
        this.logger.warn(
          `session ${tracked.sessionId}: artifact size ${size} regressed below the uploaded `
          + `watermark ${session.uploadedOffset} — the artifact was replaced or truncated; `
          + 'skipping until the watermark holds again',
        )
      }
      return
    }

    if (size === session.uploadedOffset) {
      tracked.firstPendingAt = undefined
      return
    }

    // Read the not-yet-uploaded tail. A shrink mid-read yields a short buffer
    // the scanner treats as a torn tail; the next stat flags the regression.
    const buffer = await this.readTail(tracked.path, session.uploadedOffset, size)
    let frames
    try {
      frames = scanZstdFrames(buffer).frames
    } catch (error) {
      this.lastError = String(error)
      this.logger.warn(`session ${tracked.sessionId}: artifact scan failed, skipping this pass: ${String(error)}`)
      return
    }
    if (frames.length === 0) {
      // Nothing complete past the watermark — the torn tail never ships.
      tracked.firstPendingAt = undefined
      return
    }
    tracked.firstPendingAt ??= now

    // Cut segments over complete frames: fill up to segmentBytes, then ship a
    // short tail only when the delay/dormant trigger (or a final flush) fires.
    let cursor = session.uploadedOffset
    let index = 0
    while (index < frames.length) {
      let end = index
      let bytes = 0
      do {
        bytes += frames[end]!.end - frames[end]!.start
        end++
      } while (end < frames.length && bytes < this.config.segmentBytes)
      const short = bytes < this.config.segmentBytes
      const delayElapsed = tracked.firstPendingAt !== undefined
        && now - tracked.firstPendingAt >= this.config.segmentMaxDelayMs
      if (short && !delayElapsed && !dormant && !final) break
      await this.uploadSegment(tracked, cursor, cursor + bytes, buffer.subarray(frames[index]!.start, frames[end - 1]!.end))
      cursor += bytes
      index = end
    }
    if (index === frames.length) tracked.firstPendingAt = undefined
  }

  /** Adopt the manifest watermark on first contact; warn on foreign ownership. */
  private async reconcileWithManifest(tracked: TrackedSession): Promise<void> {
    const key = manifestKey(this.config.prefix, tracked.projectDir, tracked.sessionId)
    let manifest: ShipManifest | null
    try {
      manifest = await readManifest(this.store, key)
    } catch (error) {
      // A corrupt manifest must not crash the pass; the upload path would fail
      // on it anyway, so surface and skip the reconciliation.
      this.lastError = String(error)
      this.logger.warn(`session ${tracked.sessionId}: manifest unreadable, using local state: ${String(error)}`)
      return
    }
    if (!manifest) return
    if (manifest.writerId !== this.writerId && !tracked.warnedForeign) {
      tracked.warnedForeign = true
      this.logger.warn(
        `session ${tracked.sessionId}: manifest is owned by writer ${manifest.writerId} `
        + `(this machine is ${this.writerId}) — another machine shipped this session; `
        + 'resuming from its watermark, do not run two shippers on one artifact',
      )
    }
    const session = this.state.sessions[tracked.sessionId] ?? initialSessionState()
    if (session.uploadedOffset !== manifest.watermark) {
      // The manifest is authoritative: adopt its watermark in either direction
      // (re-uploaded keys are deterministic, so a downward adopt is idempotent).
      session.uploadedOffset = manifest.watermark
      session.conflicted = false
      this.state.sessions[tracked.sessionId] = session
    }
  }

  /** Read the artifact bytes in `[offset, size)`, tolerating a mid-read shrink. */
  private async readTail(path: string, offset: number, size: number): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return buffer.subarray(0, read)
    } finally {
      await handle.close()
    }
  }

  /**
   * Upload one segment with retry, then advance the watermark: local offset
   * first (so a crash between segment put and manifest write re-puts the same
   * deterministic key), manifest second, ship-state at the end of the pass.
   */
  private async uploadSegment(tracked: TrackedSession, start: number, end: number, body: Buffer): Promise<void> {
    const key = this.objectKey(tracked, segmentKey(start, end))
    try {
      await withRetry(() => this.store.putObject(key, body), {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        onRetry: (attempt, error, delayMs) => {
          this.logger.warn(`upload ${key} failed (attempt ${attempt}, retry in ${delayMs}ms): ${String(error)}`)
        },
      })
    } catch (error) {
      // Watermark untouched: the next pass re-attempts from the same offset.
      this.lastError = String(error)
      this.logger.warn(`upload ${key} failed permanently this pass: ${String(error)}`)
      throw error
    }
    advanceSessionOffset(this.state, tracked.sessionId, end)
    const segment: ManifestSegment = {
      key,
      offsetStart: start,
      offsetEnd: end,
      bytes: end - start,
      uploadedAt: new Date().toISOString(),
    }
    await updateManifest(this.store, manifestKey(this.config.prefix, tracked.projectDir, tracked.sessionId),
      current => this.appendSegment(tracked, current, segment))
    this.uploadedSegments++
    this.uploadedBytes += segment.bytes
    this.lastUploadAt = Date.now()
  }

  /** Pure manifest transition appending one segment (idempotent on re-apply). */
  private appendSegment(tracked: TrackedSession, current: ShipManifest | null, segment: ManifestSegment): ShipManifest {
    const base: ShipManifest = current ?? {
      version: MANIFEST_VERSION,
      sessionId: tracked.sessionId,
      format: { kind: 'jsonl.zstd', sessionFormatVersion: SESSION_FORMAT_VERSION },
      writerId: this.writerId,
      watermark: 0,
      segments: [],
      updatedAt: '',
    }
    const segments = base.segments.some(existing => existing.offsetStart === segment.offsetStart)
      ? base.segments
      : [...base.segments, segment]
    return { ...base, watermark: Math.max(base.watermark, segment.offsetEnd), segments }
  }

  /** Full object key of one session-relative object name. */
  private objectKey(tracked: TrackedSession, name: string): string {
    const prefix = this.config.prefix.replace(/^\/+|\/+$/g, '')
    const base = `${tracked.projectDir}/${tracked.sessionId}/${name}`
    return prefix ? `${prefix}/${base}` : base
  }
}
