/**
 * Structural scanner for the concatenated-frame Zstandard container the
 * official `session-persistence-jsonl` backend appends to. The ship-mode
 * sink uses the scan to cut byte-aligned upload segments that never split a
 * frame and to detect (and skip) the torn tail a crash leaves behind.
 *
 * Vendored verbatim from the deepseek-harness monorepo:
 * packages/session/session-persistence-jsonl/src/zstd.ts (`scanZstdFrames`
 * plus its `ZstdFrameRange`/`ZstdFrameScan` types), commit
 * 47f943859bef60e4160492346772ded9b24f765a. Self-contained pure Buffer
 * parsing — the compression helpers are NOT vendored (the shipper uploads
 * frame bytes as-is and never re-compresses). Keep in sync with the source
 * file; the pinned commit is also noted in README.
 *
 * @module dsh-trajectory-persistence/zstd-scan
 */

const ZSTD_MAGIC = 0xfd2fb528

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  /** Complete frames in file order. */
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks. Invalid complete
 * structure rejects; EOF inside the final frame returns its start for repair.
 * @param buffer - complete bytes currently present in the session artifact.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`,
      )
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}
