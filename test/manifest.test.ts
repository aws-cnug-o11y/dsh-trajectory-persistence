import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getOrCreateWriterId,
  MANIFEST_VERSION,
  manifestKey,
  parseManifest,
  segmentKey,
  serializeManifest,
  updateManifest,
  type ObjectStore,
  type ShipManifest,
} from '../src/manifest.js'

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>()
  /** Hook fired between a putObject and the next getObject (test race injector). */
  afterPut?: () => void
  async getObject(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null
  }
  async putObject(key: string, body: Buffer | string): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body))
    this.afterPut?.()
  }
}

function manifest(overrides: Partial<ShipManifest> = {}): ShipManifest {
  return {
    version: MANIFEST_VERSION,
    sessionId: 'sess-1',
    format: { kind: 'jsonl.zstd', sessionFormatVersion: 0 },
    writerId: 'host-linux-deadbeef',
    watermark: 0,
    segments: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('segmentKey', () => {
  it('zero-pads both offsets to 14 decimal digits', () => {
    expect(segmentKey(0, 262144)).toBe('00000000000000-00000000262144.jsonl.zstd')
  })

  it('keeps lexicographic order aligned with byte order', () => {
    const keys = [segmentKey(0, 99), segmentKey(99, 262144), segmentKey(262144, 300000)]
    expect([...keys].sort()).toEqual(keys)
  })
})

describe('manifestKey', () => {
  it('joins prefix, project dir, and session id', () => {
    expect(manifestKey('dsh-trajectories', '--repo-proj--', 'sess-1')).toBe(
      'dsh-trajectories/--repo-proj--/sess-1/_manifest.json',
    )
  })

  it('trims surrounding slashes of the prefix', () => {
    expect(manifestKey('/pfx/', 'p', 's')).toBe('pfx/p/s/_manifest.json')
  })

  it('omits an empty prefix', () => {
    expect(manifestKey('', 'p', 's')).toBe('p/s/_manifest.json')
  })
})

describe('parseManifest / serializeManifest', () => {
  it('round-trips a manifest', () => {
    const original = manifest({
      watermark: 262144,
      segments: [
        {
          key: 'k',
          offsetStart: 0,
          offsetEnd: 262144,
          bytes: 262144,
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    expect(parseManifest(serializeManifest(original))).toEqual(original)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseManifest('{oops')).toThrow(/not valid JSON/)
  })

  it('rejects a non-object document', () => {
    expect(() => parseManifest('[]')).toThrow(/must be a JSON object/)
  })

  it('rejects a foreign version explicitly', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ version: 2 })))).toThrow(
      /unsupported manifest version 2 \(expected 1\)/,
    )
  })
})

describe('updateManifest', () => {
  it('creates the manifest on first contact (mutate receives null)', async () => {
    const store = new MemoryStore()
    const written = await updateManifest(store, 'k', current => {
      expect(current).toBeNull()
      return manifest({ watermark: 100 })
    })
    expect(written.watermark).toBe(100)
    const stored = parseManifest(store.objects.get('k')!.toString())
    expect(stored.watermark).toBe(100)
    expect(stored.updatedAt).not.toBe('2026-01-01T00:00:00.000Z') // stamped at write
  })

  it('mutates the stored manifest in place', async () => {
    const store = new MemoryStore()
    store.objects.set('k', Buffer.from(serializeManifest(manifest({ watermark: 50 }))))
    await updateManifest(store, 'k', current => ({
      ...current!,
      watermark: current!.watermark + 50,
    }))
    expect(parseManifest(store.objects.get('k')!.toString()).watermark).toBe(100)
  })

  it('re-reads and re-applies the mutation once when a race overwrites the first write', async () => {
    const store = new MemoryStore()
    store.objects.set('k', Buffer.from(serializeManifest(manifest({ watermark: 10 }))))
    let raced = false
    store.afterPut = () => {
      if (raced) return
      raced = true
      // Another writer lands a newer manifest between our write and verify read.
      store.objects.set(
        'k',
        Buffer.from(serializeManifest(manifest({ writerId: 'other', watermark: 20 }))),
      )
    }
    const currents: (ShipManifest | null)[] = []
    const written = await updateManifest(store, 'k', current => {
      currents.push(current)
      return manifest({ watermark: (current?.watermark ?? 0) + 5 })
    })
    expect(currents.map(c => c?.watermark)).toEqual([10, 20])
    expect(written.watermark).toBe(25)
    expect(parseManifest(store.objects.get('k')!.toString()).watermark).toBe(25)
  })
})

describe('getOrCreateWriterId', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ship-writer-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates and persists a hostname-prefixed id', async () => {
    const id = await getOrCreateWriterId(dir)
    expect(id).toMatch(/^.+-.+-[0-9a-f]{8}$/)
    expect((await readFile(join(dir, 'writer-id'), 'utf8')).trim()).toBe(id)
  })

  it('reuses the persisted id', async () => {
    const first = await getOrCreateWriterId(dir)
    expect(await getOrCreateWriterId(dir)).toBe(first)
  })

  it('recreates the id when the file is empty', async () => {
    await writeFile(join(dir, 'writer-id'), '\n')
    const id = await getOrCreateWriterId(dir)
    expect(id).toMatch(/^.+-.+-[0-9a-f]{8}$/)
  })
})
