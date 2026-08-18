import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, type ZstdOptions } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { S3SinkConfig } from '../src/config.js'
import { MANIFEST_VERSION, manifestKey, segmentKey, serializeManifest } from '../src/manifest.js'
import type { ShipManifest } from '../src/manifest.js'
import { S3ShipperSink } from '../src/shipper.js'
import { syncDown } from '../src/sync-down.js'
import type { ListableObjectStore } from '../src/sync-down.js'

// Frames carry the checksum flag like the official backend (see zstd-scan.test.ts).
const CHECKSUM_OPTIONS: ZstdOptions = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text), CHECKSUM_OPTIONS)
}

class MemoryStore implements ListableObjectStore {
  readonly objects = new Map<string, Buffer>()

  async getObject(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null
  }

  async putObject(key: string, body: Buffer | string): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body))
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort()
  }
}

const PROJ = '--repo-my-project--'
const SESS = 'sess-1'
const ARTIFACT_NAME = 'session.jsonl.zstd'

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
    segmentBytes: 1, // every complete frame is due immediately
    segmentMaxDelayMs: 3_600_000,
    dormantAfterMs: 3_600_000,
    writerId: 'test-writer',
    ...overrides,
  }
}

const ctx = {
  logger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
} as unknown as Context

function manifest(overrides: Partial<ShipManifest> = {}): ShipManifest {
  return {
    version: MANIFEST_VERSION,
    sessionId: SESS,
    format: { kind: 'jsonl.zstd', sessionFormatVersion: 0 },
    writerId: 'test-writer',
    watermark: 0,
    segments: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('syncDown', () => {
  let base: string
  let root: string
  let store: MemoryStore
  const sinks: S3ShipperSink[] = []

  function sink(config: S3SinkConfig): S3ShipperSink {
    const instance = new S3ShipperSink(ctx, config, store, join(base, 'state'))
    sinks.push(instance)
    return instance
  }

  /** Ship the current artifact under {proj}/{sess} of `root` to the store. */
  async function ship(sess = SESS, proj = PROJ): Promise<void> {
    const instance = sink(shipConfig(root))
    await instance.poll()
    await instance.close()
    expect(store.objects.has(manifestKey('dsh-trajectories', proj, sess))).toBe(true)
  }

  function down(overrides: Partial<Parameters<typeof syncDown>[0]> = {}) {
    return syncDown({
      store,
      bucket: 'bucket-1',
      prefix: 'dsh-trajectories',
      root,
      ...overrides,
    })
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-sync-down-'))
    root = join(base, 'sessions')
    store = new MemoryStore()
  })

  afterEach(async () => {
    await Promise.all(sinks.map(instance => instance.close()))
    sinks.length = 0
    await rm(base, { recursive: true, force: true })
  })

  it('round-trips an official artifact through the shipper byte-exactly', async () => {
    const header = frame(
      '{"type":"session","version":0,"id":"sess-1","createdAt":1700000000000,"delegationDepth":0}\n',
    )
    const events = [
      frame('{"type":"turn/start","seq":0}\n'),
      frame('{"type":"turn/end","seq":1}\n'),
    ]
    const artifact = Buffer.concat([header, ...events])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()

    // New machine: the local root is gone entirely.
    await rm(root, { recursive: true, force: true })

    const summary = await down()
    expect(summary.sessions).toEqual([
      { projectDir: PROJ, sessionId: SESS, status: 'restored', bytes: artifact.length },
    ])
    const restored = await readFile(join(root, PROJ, SESS, ARTIFACT_NAME))
    expect(restored.equals(artifact)).toBe(true)
  })

  it('skips a local artifact already byte-identical to the remote', async () => {
    const artifact = Buffer.concat([frame('header\n'), frame('event\n')])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()

    const summary = await down()
    expect(summary.sessions).toEqual([
      {
        projectDir: PROJ,
        sessionId: SESS,
        status: 'skipped',
        bytes: artifact.length,
        reason: 'already in sync',
      },
    ])
  })

  it('completes a local artifact that is a byte prefix of the remote', async () => {
    const parts = [frame('header\n'), frame('one\n'), frame('two\n')]
    const artifact = Buffer.concat(parts)
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()

    // Local root holds only an earlier, shorter restore (strict byte prefix).
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), Buffer.concat(parts.slice(0, 2)))

    const summary = await down()
    expect(summary.sessions).toEqual([
      { projectDir: PROJ, sessionId: SESS, status: 'appended', bytes: parts[2]!.length },
    ])
    const restored = await readFile(join(root, PROJ, SESS, ARTIFACT_NAME))
    expect(restored.equals(artifact)).toBe(true)
  })

  it('refuses a diverged local artifact without force and leaves it untouched', async () => {
    const artifact = Buffer.concat([frame('header\n'), frame('remote\n')])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()

    const diverged = Buffer.concat([frame('header\n'), frame('local fork\n')])
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), diverged)

    const summary = await down()
    expect(summary.sessions).toHaveLength(1)
    expect(summary.sessions[0]).toMatchObject({ status: 'conflict', bytes: 0 })
    expect(summary.sessions[0]!.reason).toMatch(/diverged.*--force/s)
    expect((await readFile(join(root, PROJ, SESS, ARTIFACT_NAME))).equals(diverged)).toBe(true)
    expect((await readdir(join(root, PROJ, SESS))).filter(name => name.includes('.bak-'))).toEqual(
      [],
    )
  })

  it('overwrites a diverged local artifact with force, backing the original up', async () => {
    const artifact = Buffer.concat([frame('header\n'), frame('remote\n')])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()

    const diverged = Buffer.concat([frame('header\n'), frame('local fork\n')])
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), diverged)

    const summary = await down({ force: true })
    expect(summary.sessions).toHaveLength(1)
    const result = summary.sessions[0]!
    expect(result).toMatchObject({ status: 'restored', bytes: artifact.length })
    expect(result.backupPath).toMatch(/session\.jsonl\.zstd\.bak-\d+$/)
    expect((await readFile(join(root, PROJ, SESS, ARTIFACT_NAME))).equals(artifact)).toBe(true)
    expect((await readFile(result.backupPath!)).equals(diverged)).toBe(true)
  })

  it('refuses a local artifact longer than the remote as diverged', async () => {
    const artifact = frame('short\n')
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()
    await appendFile(join(root, PROJ, SESS, ARTIFACT_NAME), frame('unshipped local tail\n'))

    const summary = await down()
    expect(summary.sessions[0]).toMatchObject({ status: 'conflict', bytes: 0 })
  })

  it('restores only the session selected by the session filter', async () => {
    const other = 'sess-2'
    for (const sess of [SESS, other]) {
      await mkdir(join(root, PROJ, sess), { recursive: true })
      await writeFile(join(root, PROJ, sess, ARTIFACT_NAME), frame(`${sess}\n`))
    }
    const instance = sink(shipConfig(root))
    await instance.poll()
    await instance.close()
    await rm(root, { recursive: true, force: true })

    const summary = await down({ sessionId: other })
    expect(summary.sessions).toEqual([
      { projectDir: PROJ, sessionId: other, status: 'restored', bytes: frame(`${other}\n`).length },
    ])
    expect(
      (await readFile(join(root, PROJ, other, ARTIFACT_NAME))).equals(frame(`${other}\n`)),
    ).toBe(true)
    await expect(readFile(join(root, PROJ, SESS, ARTIFACT_NAME))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('errors explicitly on an unsupported manifest version', async () => {
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    store.objects.set(key, Buffer.from(serializeManifest({ ...manifest(), version: 2 })))

    const summary = await down()
    expect(summary.sessions).toHaveLength(1)
    expect(summary.sessions[0]!.status).toBe('error')
    expect(summary.sessions[0]!.reason).toMatch(/unsupported manifest version 2/)
  })

  it('errors explicitly on an unsupported session format version', async () => {
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    const foreign = manifest({
      format: { kind: 'jsonl.zstd', sessionFormatVersion: 1 },
      watermark: 5,
      segments: [
        {
          key: 'unused',
          offsetStart: 0,
          offsetEnd: 5,
          bytes: 5,
          uploadedAt: new Date().toISOString(),
        },
      ],
    })
    store.objects.set(key, Buffer.from(serializeManifest(foreign)))

    const summary = await down()
    expect(summary.sessions[0]!.status).toBe('error')
    expect(summary.sessions[0]!.reason).toMatch(
      /unsupported session format version 1 \(expected 0\)/,
    )
  })

  it('errors explicitly when a segment object is missing', async () => {
    const artifact = Buffer.concat([frame('header\n'), frame('event\n')])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()
    const keys = [...store.objects.keys()].filter(key => key.endsWith('.jsonl.zstd'))
    expect(keys.length).toBeGreaterThan(0)
    store.objects.delete(keys[0]!)

    const summary = await down()
    expect(summary.sessions[0]!.status).toBe('error')
    expect(summary.sessions[0]!.reason).toMatch(/segment .* is missing/)
  })

  it('errors explicitly when the watermark disagrees with the segment list', async () => {
    const artifact = frame('only\n')
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    const stored = JSON.parse(store.objects.get(key)!.toString('utf8')) as ShipManifest
    store.objects.set(
      key,
      Buffer.from(serializeManifest({ ...stored, watermark: stored.watermark + 10 })),
    )
    await rm(root, { recursive: true, force: true })

    const summary = await down()
    expect(summary.sessions[0]!.status).toBe('error')
    expect(summary.sessions[0]!.reason).toMatch(
      /segments end at offset \d+ but the watermark is \d+/,
    )
  })

  it('errors explicitly on a segment gap in the manifest', async () => {
    const artifact = Buffer.concat([frame('a\n'), frame('b\n')])
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), artifact)
    await ship()
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    const stored = JSON.parse(store.objects.get(key)!.toString('utf8')) as ShipManifest
    // Drop the first segment: the remaining list no longer starts at offset 0.
    store.objects.set(
      key,
      Buffer.from(serializeManifest({ ...stored, segments: stored.segments.slice(1) })),
    )
    await rm(root, { recursive: true, force: true })

    const summary = await down()
    expect(summary.sessions[0]!.status).toBe('error')
    expect(summary.sessions[0]!.reason).toMatch(/segment gap\/overlap/)
  })

  it('reports an empty summary when nothing was shipped', async () => {
    const summary = await down()
    expect(summary.sessions).toEqual([])
  })

  it('skips a session whose watermark is still 0', async () => {
    const key = manifestKey('dsh-trajectories', PROJ, SESS)
    store.objects.set(key, Buffer.from(serializeManifest(manifest())))

    const summary = await down()
    expect(summary.sessions).toEqual([
      {
        projectDir: PROJ,
        sessionId: SESS,
        status: 'skipped',
        bytes: 0,
        reason: 'manifest watermark is 0 — nothing shipped yet',
      },
    ])
  })

  it('exercises the real key layout produced by the shipper (zero-padded segment keys)', async () => {
    const parts = [frame('h\n'), frame('e\n')]
    await mkdir(join(root, PROJ, SESS), { recursive: true })
    await writeFile(join(root, PROJ, SESS, ARTIFACT_NAME), Buffer.concat(parts))
    await ship()
    expect(
      store.objects.has(`dsh-trajectories/${PROJ}/${SESS}/${segmentKey(0, parts[0]!.length)}`),
    ).toBe(true)
    await rm(root, { recursive: true, force: true })

    const lines: string[] = []
    const summary = await down({ log: line => lines.push(line) })
    expect(summary.sessions[0]!.status).toBe('restored')
    expect(lines).toEqual([
      expect.stringMatching(/^restored {2}--repo-my-project--\/sess-1 {2}\d+ bytes$/),
    ])
  })
})
