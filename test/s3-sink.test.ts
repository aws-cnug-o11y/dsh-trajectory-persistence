import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { EventBuffer, S3TrajectorySink } from '../src/s3-sink.js'
import type { ObjectUploader } from '../src/s3-sink.js'
import type { S3SinkConfig } from '../src/config.js'
import { ev, fakeCtx, fakeHeader, fakeSession, resetClock } from './helpers.js'

class MockUploader implements ObjectUploader {
  puts: { key: string; body: string }[] = []
  failuresBeforeSuccess = 0
  alwaysFail = false
  attempts = 0
  closeCount = 0

  async putObject(key: string, body: string): Promise<void> {
    this.attempts++
    if (this.alwaysFail || this.failuresBeforeSuccess > 0) {
      if (this.failuresBeforeSuccess > 0) this.failuresBeforeSuccess--
      throw new Error('simulated upload failure')
    }
    this.puts.push({ key, body })
  }

  async close(): Promise<void> {
    this.closeCount++
  }
}

function config(overrides: Partial<S3SinkConfig> = {}, deadLetterDir = '/nonexistent-deadletter'): S3SinkConfig {
  return {
    enabled: true,
    bucket: 'bucket-1',
    prefix: 'dsh-trajectories',
    region: 'us-east-1',
    batchSize: 3,
    maxBufferedEvents: 100,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    deadLetterDir,
    ...overrides,
  }
}

function turnEvents(seqs: number[]): SessionEvent[] {
  return seqs.map(seq => ev('turn/start', seq, { turn: seq }))
}

describe('EventBuffer', () => {
  it('drops the oldest event at capacity (ring semantics)', () => {
    const buffer = new EventBuffer(2)
    buffer.push(turnEvents([1])[0])
    buffer.push(turnEvents([2])[0])
    buffer.push(turnEvents([3])[0])
    expect(buffer.size).toBe(2)
    expect(buffer.dropped).toBe(1)
    expect(buffer.takeAll().map(e => e.seq)).toEqual([2, 3])
  })

  it('rejects non-positive capacity', () => {
    expect(() => new EventBuffer(0)).toThrow()
  })
})

describe('S3TrajectorySink', () => {
  beforeEach(resetClock)

  it('flushes when the buffer reaches batchSize, with the expected key and header line', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
    await sink.close()

    expect(uploader.puts).toHaveLength(1)
    const { key, body } = uploader.puts[0]
    expect(key).toBe('dsh-trajectories/--repo-my-project--/sess-1/0-2.jsonl')
    const lines = body.trimEnd().split('\n')
    expect(lines).toHaveLength(4) // header + 3 events
    const header = JSON.parse(lines[0])
    expect(header).toMatchObject({ type: 'session', id: 'sess-1', cwd: '/repo/my-project', delegationDepth: 0 })
    const event = JSON.parse(lines[1])
    expect(event).toMatchObject({ type: 'turn/start', seq: 0 })
  })

  it('flushes on the session/flush hint below batchSize', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1])) sink.onEvent(session, event)
    expect(uploader.puts).toHaveLength(0)
    sink.onFlush(session)
    await sink.close()

    expect(uploader.puts).toHaveLength(1)
    expect(uploader.puts[0].key).toBe('dsh-trajectories/--repo-my-project--/sess-1/0-1.jsonl')
  })

  it('onFlush returns a promise that settles after the upload completes', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1])) sink.onEvent(session, event)

    const flushed = sink.onFlush(session)
    expect(flushed).toBeInstanceOf(Promise)
    await flushed!

    expect(uploader.puts).toHaveLength(1)
    expect(uploader.puts[0].key).toBe('dsh-trajectories/--repo-my-project--/sess-1/0-1.jsonl')
    await sink.close()
  })

  it('flushes on session/disposed and encodes unsafe session ids in keys', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession(fakeHeader({ id: 'we~ird/id' as never, cwd: undefined }))
    sink.sessionCreated(session)
    sink.onEvent(session, turnEvents([5])[0])
    sink.onDisposed(session)
    await sink.close()

    expect(uploader.puts).toHaveLength(1)
    expect(uploader.puts[0].key).toBe('dsh-trajectories/_no-cwd/we~007Eird~002Fid/5-5.jsonl')
    const header = JSON.parse(uploader.puts[0].body.split('\n')[0])
    expect(header.cwd).toBeUndefined()
  })

  it('splits an oversized buffer into ordered batchSize parts', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config({ batchSize: 2 }), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2, 3, 4])) sink.onEvent(session, event)
    await sink.close()

    expect(uploader.puts.map(p => p.key)).toEqual([
      'dsh-trajectories/--repo-my-project--/sess-1/0-1.jsonl',
      'dsh-trajectories/--repo-my-project--/sess-1/2-3.jsonl',
      'dsh-trajectories/--repo-my-project--/sess-1/4-4.jsonl',
    ])
  })

  it('retries a failing upload with backoff and eventually succeeds', async () => {
    const uploader = new MockUploader()
    uploader.failuresBeforeSuccess = 2
    const sink = new S3TrajectorySink(fakeCtx(), config({ maxRetries: 3 }), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
    await sink.close()

    expect(uploader.attempts).toBe(3) // initial + 2 retries
    expect(uploader.puts).toHaveLength(1)
  })

  it('writes a dead-letter file when the upload finally fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-deadletter-'))
    const uploader = new MockUploader()
    uploader.alwaysFail = true
    const sink = new S3TrajectorySink(fakeCtx(), config({ maxRetries: 1 }, dir), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
    await sink.close()

    expect(uploader.puts).toHaveLength(0)
    expect(uploader.attempts).toBe(2)
    const files = await readdir(join(dir, '--repo-my-project--', 'sess-1'))
    expect(files).toEqual(['0-2.jsonl'])
    const content = await readFile(join(dir, '--repo-my-project--', 'sess-1', '0-2.jsonl'), 'utf8')
    expect(content.split('\n')[0]).toContain('"type":"session"')
  })

  it('drains remaining buffered events on close even without other triggers', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    sink.onEvent(session, turnEvents([9])[0])
    await sink.close()

    expect(uploader.puts).toHaveLength(1)
    expect(uploader.puts[0].key).toBe('dsh-trajectories/--repo-my-project--/sess-1/9-9.jsonl')
  })

  it('keeps flushing after a dead-letter write failure and still closes the uploader', async () => {
    // deadLetterDir pointing at a regular file makes mkdir fail with ENOTDIR.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-deadletter-blocked-'))
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, '')
    const uploader = new MockUploader()
    uploader.alwaysFail = true
    const sink = new S3TrajectorySink(fakeCtx(), config({ maxRetries: 0 }, blocker), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
    // Let the failed flush (upload + dead-letter write) fully settle.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(uploader.attempts).toBe(1)

    for (const event of turnEvents([3, 4, 5])) sink.onEvent(session, event)
    await sink.close()

    // The queue survived the failure: the second batch triggered a fresh upload attempt.
    expect(uploader.attempts).toBe(2)
    expect(uploader.closeCount).toBe(1)
  })

  it('drops session activity after close()', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    sink.onEvent(session, turnEvents([0])[0])
    await sink.close()
    expect(uploader.puts).toHaveLength(1)

    sink.sessionCreated(session)
    for (const event of turnEvents([1, 2, 3])) sink.onEvent(session, event)
    sink.onFlush(session)
    sink.onDisposed(session)

    expect(uploader.attempts).toBe(1)
    expect(uploader.puts).toHaveLength(1)
  })

  it('close() is idempotent', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    sink.onEvent(session, turnEvents([0])[0])
    await sink.close()
    await sink.close()

    expect(uploader.puts).toHaveLength(1)
    expect(uploader.closeCount).toBe(1)
  })

  it('builds keys without a leading slash when the prefix is empty', async () => {
    const uploader = new MockUploader()
    const sink = new S3TrajectorySink(fakeCtx(), config({ prefix: '' }), uploader)
    const session = fakeSession()
    sink.sessionCreated(session)
    for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
    await sink.close()

    expect(uploader.puts[0].key).toBe('--repo-my-project--/sess-1/0-2.jsonl')
  })

  it('rejects batchSize greater than maxBufferedEvents', () => {
    expect(() => new S3TrajectorySink(fakeCtx(), config({ batchSize: 10, maxBufferedEvents: 5 }), new MockUploader()))
      .toThrow(/batchSize/)
  })

  describe('stats()', () => {
    it('counts successful uploads and reports the last upload time', async () => {
      const uploader = new MockUploader()
      const sink = new S3TrajectorySink(fakeCtx(), config(), uploader)
      const session = fakeSession()
      sink.sessionCreated(session)
      for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
      await sink.close()

      const stats = sink.stats()
      expect(stats.uploadedParts).toBe(1)
      expect(stats.deadLetteredParts).toBe(0)
      expect(stats.droppedEvents).toBe(0)
      expect(stats.lastUploadAt).toEqual(expect.any(Number))
      expect(stats.lastError).toBeUndefined()
    })

    it('counts sessions and buffered events before a flush', () => {
      const uploader = new MockUploader()
      const sink = new S3TrajectorySink(fakeCtx(), config({ batchSize: 10 }), uploader)
      const session = fakeSession()
      sink.sessionCreated(session)
      for (const event of turnEvents([0, 1])) sink.onEvent(session, event)

      const stats = sink.stats()
      expect(stats.sessions).toBe(1)
      expect(stats.bufferedEvents).toBe(2)
      expect(stats.uploadedParts).toBe(0)
      expect(stats.lastUploadAt).toBeUndefined()
    })

    it('counts permanent upload failures and keeps the last error message', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-deadletter-'))
      const uploader = new MockUploader()
      uploader.alwaysFail = true
      const sink = new S3TrajectorySink(fakeCtx(), config({ maxRetries: 0 }, dir), uploader)
      const session = fakeSession()
      sink.sessionCreated(session)
      for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)
      await sink.close()

      const stats = sink.stats()
      expect(stats.uploadedParts).toBe(0)
      expect(stats.deadLetteredParts).toBe(1)
      expect(stats.lastUploadAt).toBeUndefined()
      expect(stats.lastError).toContain('simulated upload failure')
    })

    it('counts events dropped by buffer overflow', async () => {
      const uploader = new MockUploader()
      // batchSize == capacity: the third push overflows before the async flush runs.
      const sink = new S3TrajectorySink(fakeCtx(), config({ batchSize: 2, maxBufferedEvents: 2 }), uploader)
      const session = fakeSession()
      sink.sessionCreated(session)
      for (const event of turnEvents([0, 1, 2])) sink.onEvent(session, event)

      expect(sink.stats().droppedEvents).toBe(1)
      await sink.close()
      // The surviving two events uploaded as one part.
      expect(uploader.puts.map(p => p.key)).toEqual(['dsh-trajectories/--repo-my-project--/sess-1/1-2.jsonl'])
      expect(sink.stats().droppedEvents).toBe(1)
      expect(sink.stats().uploadedParts).toBe(1)
    })
  })
})
