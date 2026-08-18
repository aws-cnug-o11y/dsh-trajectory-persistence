import { constants, zstdCompressSync, zstdDecompressSync, type ZstdOptions } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { scanZstdFrames } from '../src/zstd-scan.js'

// The official backend always compresses with the checksum flag set
// (packages/session/session-persistence-jsonl/src/zstd.ts CHECKSUM_OPTIONS).
const CHECKSUM_OPTIONS: ZstdOptions = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text), CHECKSUM_OPTIONS)
}

function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts)
}

describe('scanZstdFrames', () => {
  it('scans a multi-frame concatenation and every frame round-trips', () => {
    const payloads = [
      '{"type":"session","id":"s1"}\n',
      '{"type":"a"}\n',
      '{"type":"b"}\n{"type":"c"}\n',
    ]
    const parts = payloads.map(frame)
    const scan = scanZstdFrames(concat(...parts))
    expect(scan.tornStart).toBeUndefined()
    expect(scan.frames).toHaveLength(3)
    let cursor = 0
    for (const [i, range] of scan.frames.entries()) {
      expect(range.start).toBe(cursor)
      expect(range.end).toBe(cursor + parts[i]!.length)
      cursor = range.end
      const slice = concat(...parts).subarray(range.start, range.end)
      expect(zstdDecompressSync(slice).toString()).toBe(payloads[i])
    }
    expect(cursor).toBe(concat(...parts).length)
  })

  it('returns zero frames for an empty buffer without reporting a torn tail', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
  })

  it('honors maxFrames and drops the torn tail marker', () => {
    const parts = [frame('a'), frame('b'), frame('c')]
    const scan = scanZstdFrames(concat(...parts), 2)
    expect(scan.frames).toHaveLength(2)
    expect(scan.tornStart).toBeUndefined()
  })

  describe('torn tail truncation points', () => {
    const whole = concat(frame('first batch'), frame('second batch, truncated mid-flight'))
    const firstEnd = scanZstdFrames(whole).frames[0]!.end

    it('EOF inside the frame header', () => {
      // Keep magic + descriptor but cut the window-descriptor byte.
      const cut = firstEnd + 5
      const scan = scanZstdFrames(whole.subarray(0, cut))
      expect(scan.frames).toEqual([{ start: 0, end: firstEnd }])
      expect(scan.tornStart).toBe(firstEnd)
    })

    it('EOF inside a block payload', () => {
      // The trailing checksum occupies the frame's final 4 bytes, so cutting
      // 5 short lands inside the last block payload.
      const cut = whole.length - 5
      const scan = scanZstdFrames(whole.subarray(0, cut))
      expect(scan.frames).toEqual([{ start: 0, end: firstEnd }])
      expect(scan.tornStart).toBe(firstEnd)
    })

    it('EOF inside the trailing checksum', () => {
      const cut = whole.length - 2
      const scan = scanZstdFrames(whole.subarray(0, cut))
      expect(scan.frames).toEqual([{ start: 0, end: firstEnd }])
      expect(scan.tornStart).toBe(firstEnd)
    })

    it('EOF with fewer than 4 header bytes of the next frame', () => {
      const cut = firstEnd + 2
      const scan = scanZstdFrames(whole.subarray(0, cut))
      expect(scan.frames).toEqual([{ start: 0, end: firstEnd }])
      expect(scan.tornStart).toBe(firstEnd)
    })
  })

  it('rejects an invalid frame magic', () => {
    const bad = Buffer.from(frame('data'))
    bad.writeUInt32LE(0xdeadbeef, 0)
    expect(() => scanZstdFrames(bad)).toThrow(/invalid frame magic at byte 0/)
  })

  it('rejects a set reserved frame-header bit', () => {
    const bad = Buffer.from(frame('data'))
    // Descriptor sits at byte 4; bits 3-4 (mask 0x18) are reserved.
    bad.writeUInt8(bad.readUInt8(4) | 0x08, 4)
    expect(() => scanZstdFrames(bad)).toThrow(/reserved frame-header bit at byte 4/)
  })

  it('rejects a reserved block type', () => {
    // Hand-built frame: magic, descriptor (single segment, 1-byte content size,
    // no checksum), content size, then one block with the reserved type 0x03.
    const bad = Buffer.alloc(4 + 1 + 1 + 3)
    bad.writeUInt32LE(0xfd2fb528, 0)
    bad.writeUInt8(0x20, 4) // single-segment descriptor
    bad.writeUInt8(0, 5) // content size 0
    bad.writeUIntLE(0b111, 6, 3) // lastBlock=1, blockType=3, size=0
    expect(() => scanZstdFrames(bad)).toThrow(/reserved block type at byte 6/)
  })
})
