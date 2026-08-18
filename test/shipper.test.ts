import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, type ZstdOptions } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3SinkConfig } from '../src/config.js'
import { MANIFEST_VERSION, manifestKey, parseManifest, segmentKey } from '../src/manifest.js'
import type { ObjectStore, ShipManifest } from '../src/manifest.js'
import { loadShipState } from '../src/ship-state.js'
import { S3ShipperSink } from '../src/shipper.js'

// Frames carry the checksum flag like the official backend (see zstd-scan.test.ts).
const CHECKSUM_OPTIONS: ZstdOptions = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text), CHECKSUM_OPTIONS)
}

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>()

  async getObject(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null
  }

  async putObject(key: string, body: Buffer | string): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body))
  }

  /** Keys of uploaded segments (everything but manifests), in insertion order. */
  segmentKeys(): string[] {
    return [...this.objects.keys()].filter(key => key.endsWith('.jsonl.zstd'))
  }
}

const PROJ = '--repo-my-project--'
const SESS = 'sess-1'

function shipConfig(root: string, overrides: Partial<S3SinkConfig> = {}): S3SinkConfig {
  return {
    enabled: true,
    mode: 'ship',
    bucket: 'bucket-1',
    prefix: 'dsh-trajectories',
    region: 'us-east-1',
    batchSize: 100,
    maxBufferedEvents: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    deadLetterDir: '/nonexistent-deadletter',
    root,
    // Huge poll interval: tests drive poll() manually, the timer never fires.
    pollIntervalMs: 3_600_000,
    segmentBytes: 262_144,
    segmentMaxDelayMs: 3_600_000,
    dormantAfterMs: 3_600_000,
    writerId: 'test-writer',
    ...overrides,
  }
}

function spyCtx(): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const ctx = {
    logger: () => ({ warn, info: () => {}, debug: () => {}, error: () => {} }),
  } as unknown as Context
  return { ctx, warn }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('S3ShipperSink', () => {
  let base: string
  let root: string
  let stateDir: string
  let artifact: string
  let store: MemoryStore
  let warn: ReturnType<typeof vi.fn>
  let ctx: Context
  const sinks: S3ShipperSink[] = []

  function sink(config: S3SinkConfig, dir = stateDir): S3ShipperSink {
    const instance = new S3ShipperSink(ctx, config, store, dir)
    sinks.push(instance)
    return instance
  }

  async function writeArtifact(data: Buffer): Promise<void> {
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(artifact, data)
  }

  function readManifest(): ShipManifest {
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    return parseManifest(store.objects.get(key)!.toString('utf8'))
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-shipper-'))
    root = join(base, 'sessions')
    stateDir = join(base, 'state')
    artifact = join(root, PROJ, SESS, 'session.jsonl.zstd')
    store = new MemoryStore()
    ;({ ctx, warn } = spyCtx())
  })

  afterEach(async () => {
    await Promise.all(sinks.map(instance => instance.close()))
    sinks.length = 0
    await rm(base, { recursive: true, force: true })
  })

  it('ships incremental appends as ordered, byte-exact segments', async () => {
    const parts = [frame('{"type":"session"}\n'), frame('event-2'), frame('event-3'), frame('event-4')]
    const instance = sink(shipConfig(root, { segmentBytes: 1 })) // every complete frame is due

    await writeArtifact(Buffer.concat(parts.slice(0, 2)))
    await instance.poll()
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, parts[0].length)}`,
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(parts[0].length, parts[0].length + parts[1].length)}`,
    ])

    await appendFile(artifact, Buffer.concat(parts.slice(2)))
    await instance.poll()

    // Zero-padded keys: lexicographic order equals byte order.
    const keys = store.segmentKeys()
    expect(keys).toEqual([...keys].sort())
    // Concatenated segment bytes reproduce the artifact prefix exactly.
    const shipped = Buffer.concat(keys.map(key => store.objects.get(key)!))
    expect(shipped.equals(Buffer.concat(parts))).toBe(true)

    const manifest = readManifest()
    expect(manifest.watermark).toBe(shipped.length)
    expect(manifest.writerId).toBe('test-writer')
    expect(manifest.segments.map(s => [s.offsetStart, s.offsetEnd, s.bytes])).toEqual([
      [0, parts[0].length, parts[0].length],
      [parts[0].length, parts[0].length + parts[1].length, parts[1].length],
      [parts[0].length + parts[1].length, parts[0].length + parts[1].length + parts[2].length, parts[2].length],
      [shipped.length - parts[3].length, shipped.length, parts[3].length],
    ])
    const state = await loadShipState(stateDir)
    expect(state.sessions[SESS]!.uploadedOffset).toBe(shipped.length)
    expect(instance.stats()).toMatchObject({
      mode: 'ship', trackedSessions: 1, uploadedSegments: 4, uploadedBytes: shipped.length, lagBytes: 0,
    })
  })

  it('holds a short pending tail below segmentBytes until a trigger fires', async () => {
    const parts = [frame('a'), frame('b')]
    const instance = sink(shipConfig(root, { segmentBytes: parts[0].length + parts[1].length + 1 }))

    await writeArtifact(Buffer.concat(parts))
    await instance.poll()

    expect(store.segmentKeys()).toEqual([])
    expect(instance.stats().lagBytes).toBe(parts[0].length + parts[1].length)
  })

  it('flushes a short segment after segmentMaxDelayMs without growth', async () => {
    const part = frame('only frame')
    const instance = sink(shipConfig(root, { segmentMaxDelayMs: 20 }))

    await writeArtifact(part)
    await instance.poll()
    expect(store.segmentKeys()).toEqual([])

    await sleep(50)
    await instance.poll()
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, part.length)}`,
    ])
    expect(store.objects.get(store.segmentKeys()[0])!.equals(part)).toBe(true)
  })

  it('flushes pending frames when the session goes dormant', async () => {
    const parts = [frame('quiet'), frame('session')]
    const part = Buffer.concat(parts)
    const instance = sink(shipConfig(root, { dormantAfterMs: 20 }))

    await writeArtifact(part)
    await instance.poll()
    expect(store.segmentKeys()).toEqual([])

    await sleep(50)
    await instance.poll()
    // The short remainder ships as ONE segment covering both complete frames.
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, part.length)}`,
    ])
    expect(store.objects.get(store.segmentKeys()[0])!.equals(part)).toBe(true)
    const state = await loadShipState(stateDir)
    expect(state.sessions[SESS]!.dormant).toBe(true)
    expect(instance.stats().dormantSessions).toBe(1)
  })

  it('never ships a torn tail', async () => {
    const full = frame('complete')
    const torn = frame('still being written').subarray(0, 7)
    const instance = sink(shipConfig(root, { segmentBytes: 1 }))

    await writeArtifact(Buffer.concat([full, torn]))
    await instance.poll()

    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, full.length)}`,
    ])
    expect(store.objects.get(store.segmentKeys()[0])!.equals(full)).toBe(true)
    expect(instance.stats().lagBytes).toBe(torn.length)

    // The tail completes: the rest of the frame ships, nothing was re-cut.
    const rest = frame('still being written').subarray(7)
    await appendFile(artifact, rest)
    await instance.poll()
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, full.length)}`,
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(full.length, full.length + frame('still being written').length)}`,
    ])
  })

  it('resumes from ship-state after a crash and from the manifest with a fresh state dir', async () => {
    const parts = [frame('one'), frame('two'), frame('three')]
    const config = shipConfig(root, { segmentBytes: 1 })
    await writeArtifact(parts[0])

    const crashed = sink(config)
    await crashed.poll()
    expect(store.segmentKeys()).toHaveLength(1)
    // "Crash": no close(), a new instance takes over the same stateDir.

    const restarted = sink(config)
    await restarted.poll()
    expect(store.segmentKeys()).toHaveLength(1) // no re-upload

    await appendFile(artifact, parts[1])
    await restarted.poll()
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, parts[0].length)}`,
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(parts[0].length, parts[0].length + parts[1].length)}`,
    ])

    // Local state lost entirely: the manifest watermark is authoritative.
    const freshStateDir = join(base, 'state-fresh')
    const recovered = sink(config, freshStateDir)
    await recovered.poll()
    expect(store.segmentKeys()).toHaveLength(2) // still no re-upload

    await appendFile(artifact, parts[2])
    await recovered.poll()
    const total = parts[0].length + parts[1].length + parts[2].length
    expect(store.segmentKeys()).toHaveLength(3)
    expect(readManifest().watermark).toBe(total)
  })

  it('wakes a dormant session when the artifact grows again', async () => {
    const small = frame('tail')
    const parts = [frame('wake-1'), frame('wake-2')]
    const growth = parts[0].length + parts[1].length
    const instance = sink(shipConfig(root, { segmentBytes: growth, dormantAfterMs: 20 }))

    await writeArtifact(small)
    await instance.poll()
    await sleep(50)
    await instance.poll() // goes dormant: short remainder ships immediately
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, small.length)}`,
    ])

    await appendFile(artifact, Buffer.concat(parts))
    await instance.poll()
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, small.length)}`,
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(small.length, small.length + growth)}`,
    ])
    const state = await loadShipState(stateDir)
    expect(state.sessions[SESS]!.dormant).toBe(false)
    expect(state.sessions[SESS]!.uploadedOffset).toBe(small.length + growth)
  })

  it('flags a size regression as conflicted, warns once, and ships nothing further', async () => {
    const parts = [frame('one'), frame('two')]
    const uploaded = parts[0].length + parts[1].length
    const instance = sink(shipConfig(root, { segmentBytes: 1 }))

    await writeArtifact(Buffer.concat(parts))
    await instance.poll()
    expect(store.segmentKeys()).toHaveLength(2) // one segment per frame

    // The artifact is replaced by a shorter one (e.g. session reset on disk).
    await writeArtifact(parts[0].subarray(0, 5))
    await instance.poll()
    expect(store.segmentKeys()).toHaveLength(2) // nothing shipped
    expect(warn.mock.calls.some(([message]) => /regressed below the uploaded watermark/.test(message))).toBe(true)
    expect(instance.stats().conflicted).toEqual([`${PROJ}/${SESS}`])
    const conflictWarns = warn.mock.calls.filter(([message]) => /regressed below/.test(message)).length

    await instance.poll() // warn once, not per pass
    expect(warn.mock.calls.filter(([message]) => /regressed below/.test(message))).toHaveLength(conflictWarns)

    // Even when the artifact grows past the watermark again, the conflict
    // persists — resolution requires an explicit watermark advance elsewhere.
    await appendFile(artifact, Buffer.concat([parts[0].subarray(5), parts[1], frame('three')]))
    await instance.poll()
    expect(store.segmentKeys()).toHaveLength(2)
    expect(instance.stats().conflicted).toEqual([`${PROJ}/${SESS}`])
    expect((await loadShipState(stateDir)).sessions[SESS]!.uploadedOffset).toBe(uploaded)
  })

  it('warns about a foreign manifest writer but resumes from its watermark', async () => {
    const parts = [frame('from another machine'), frame('local continuation')]
    const first = parts[0].length
    const mkey = manifestKey('dsh-trajectories', PROJ, SESS)
    const foreign: ShipManifest = {
      version: MANIFEST_VERSION,
      sessionId: SESS,
      format: { kind: 'jsonl.zstd', sessionFormatVersion: 1 },
      writerId: 'other-machine',
      watermark: first,
      segments: [{
        key: `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, first)}`,
        offsetStart: 0,
        offsetEnd: first,
        bytes: first,
        uploadedAt: new Date().toISOString(),
      }],
      updatedAt: new Date().toISOString(),
    }
    store.objects.set(mkey, Buffer.from(JSON.stringify(foreign)))
    await writeArtifact(Buffer.concat(parts))

    const instance = sink(shipConfig(root, { segmentBytes: 1 }))
    await instance.poll()

    expect(warn.mock.calls.some(([message]) => /owned by writer other-machine/.test(message))).toBe(true)
    // Continued from the foreign watermark instead of re-shipping the prefix.
    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(first, first + parts[1].length)}`,
    ])
    const manifest = readManifest()
    expect(manifest.watermark).toBe(first + parts[1].length)
    expect(manifest.segments).toHaveLength(2)
    expect(manifest.writerId).toBe('other-machine') // ownership is not stomped
  })

  it('close() flushes pending frames once and is idempotent', async () => {
    const part = frame('final words')
    const instance = sink(shipConfig(root)) // all thresholds huge: nothing due

    await writeArtifact(part)
    await instance.poll()
    expect(store.segmentKeys()).toEqual([])

    const first = instance.close()
    const second = instance.close()
    expect(second).toBe(first)
    await Promise.all([first, second])
    await instance.close() // still the same settled close

    expect(store.segmentKeys()).toEqual([
      `dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, part.length)}`,
    ])
    expect(readManifest().watermark).toBe(part.length)
    expect((await loadShipState(stateDir)).sessions[SESS]!.uploadedOffset).toBe(part.length)
  })
})
