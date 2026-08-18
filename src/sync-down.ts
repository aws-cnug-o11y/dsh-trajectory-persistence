/**
 * Sync-down: restore the official `session.jsonl.zstd` artifacts of the
 * `session-persistence-jsonl` backend from the segments a ship-mode sink
 * uploaded to S3 (see `./shipper.js`), so a fresh machine can list/resume the
 * sessions with dsh. Segments are pure byte ranges of the artifact cut on
 * zstd frame boundaries, so restoring is a concatenation — no re-encoding.
 *
 * Local publish follows the official backend's durability semantics:
 * temp file + fsync, then an atomic publish (hard link for a no-overwrite
 * create, rename for a replace) plus a parent-directory fsync. A local
 * artifact that is a byte prefix of the remote is completed in place; an
 * identical one is skipped; a diverged one is refused unless `force` is set
 * (then it is backed up to `session.jsonl.zstd.bak-<epochMs>` first).
 *
 * Precondition: dsh is not running against `root` (single-writer discipline).
 *
 * @module dsh-trajectory-persistence/sync-down
 */

import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { parseManifest } from './manifest.js'
import type { ObjectStore, ShipManifest } from './manifest.js'
import { encodeSegment } from './jsonl.js'

/** Name of the artifact file inside each session directory. */
const ARTIFACT_NAME = 'session.jsonl.zstd'
/** Name of the per-session manifest object. */
const MANIFEST_NAME = '_manifest.json'

/** Object store with the listing capability sync-down needs to discover manifests. */
export interface ListableObjectStore extends ObjectStore {
  /** List every object key under `prefix` (empty array when none). */
  list(prefix: string): Promise<string[]>
}

/** Options of {@link syncDown}. */
export interface SyncDownOptions {
  /** Object store holding the shipped segments and manifests. */
  store: ListableObjectStore
  /** Bucket name (reporting only — the store already addresses it). */
  bucket: string
  /** Key prefix the shipper uploaded under. */
  prefix: string
  /** Local session root receiving restored artifacts (the official backend's root). */
  root: string
  /** Restore only this session id (raw or key-encoded); absent restores every session. */
  sessionId?: string
  /** Overwrite a diverged local artifact (backing it up first). */
  force?: boolean
  /** Per-session progress line sink; defaults to silent. */
  log?: (line: string) => void
}

/** Outcome of one session. */
export type SyncDownStatus = 'restored' | 'appended' | 'skipped' | 'conflict' | 'error'

/** Per-session summary entry. */
export interface SessionSyncResult {
  /** Encoded project directory segment (first level under `root`). */
  projectDir: string
  /** Encoded session id segment (second level under `root`). */
  sessionId: string
  status: SyncDownStatus
  /** Bytes written this run (`restored`/`appended`) or the artifact size (`skipped`). */
  bytes: number
  /** Human-readable detail for `skipped`/`conflict`/`error`. */
  reason?: string
  /** Backup path of a force-overwritten local artifact. */
  backupPath?: string
}

/** Aggregate result of one {@link syncDown} run. */
export interface SyncDownSummary {
  sessions: SessionSyncResult[]
}

/**
 * Restore every shipped session (or only `options.sessionId`) into
 * `options.root`. Never rejects for per-session failures — those surface as
 * `error` entries in the summary; only the initial listing propagates.
 * @param options - see {@link SyncDownOptions}.
 * @returns the per-session summary.
 */
export async function syncDown(options: SyncDownOptions): Promise<SyncDownSummary> {
  const log = options.log ?? (() => {})
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '')
  const keys = await options.store.list(prefix ? `${prefix}/` : '')
  const sessions: SessionSyncResult[] = []
  for (const key of keys.sort()) {
    if (!key.endsWith(`/${MANIFEST_NAME}`)) continue
    const rel = prefix ? key.slice(prefix.length + 1) : key
    const parts = rel.split('/')
    // Layout is exactly {projectDir}/{sessionId}/_manifest.json.
    if (parts.length !== 3) continue
    const [projectDir, sessionId] = parts as [string, string]
    if (
      options.sessionId !== undefined &&
      sessionId !== options.sessionId &&
      sessionId !== encodeSegment(options.sessionId)
    ) {
      continue
    }
    const result = await syncSession(options, projectDir, sessionId, key)
    sessions.push(result)
    log(formatResult(result))
  }
  return { sessions }
}

/** One-line rendering of a per-session result, used for the `log` callback. */
function formatResult(result: SessionSyncResult): string {
  const label = `${result.projectDir}/${result.sessionId}`
  switch (result.status) {
    case 'restored':
      return result.backupPath !== undefined
        ? `restored  ${label}  ${result.bytes} bytes (diverged local backed up to ${result.backupPath})`
        : `restored  ${label}  ${result.bytes} bytes`
    case 'appended':
      return `appended  ${label}  +${result.bytes} bytes`
    case 'skipped':
      return `skipped   ${label}  (${result.reason ?? 'already in sync'})`
    case 'conflict':
      return `conflict  ${label}  (${result.reason})`
    case 'error':
      return `error     ${label}  (${result.reason})`
  }
}

/** Restore one session from its manifest; per-session failures become `error` results. */
async function syncSession(
  options: SyncDownOptions,
  projectDir: string,
  sessionId: string,
  key: string,
): Promise<SessionSyncResult> {
  const base = { projectDir, sessionId, bytes: 0 }
  try {
    const body = await options.store.getObject(key)
    if (body === null) {
      return { ...base, status: 'error', reason: 'manifest vanished between listing and read' }
    }
    const manifest = parseManifest(body.toString('utf8')) // refuses version !== MANIFEST_VERSION
    if (manifest.format?.kind !== 'jsonl.zstd') {
      return {
        ...base,
        status: 'error',
        reason: `unsupported artifact format ${String(manifest.format?.kind)}`,
      }
    }
    if (manifest.format.sessionFormatVersion !== SESSION_FORMAT_VERSION) {
      return {
        ...base,
        status: 'error',
        reason:
          `unsupported session format version ${String(manifest.format.sessionFormatVersion)} ` +
          `(expected ${SESSION_FORMAT_VERSION})`,
      }
    }
    validateSegments(manifest)
    const remote = await downloadSegments(options.store, manifest)
    if (remote.length === 0) {
      return {
        ...base,
        status: 'skipped',
        reason: 'manifest watermark is 0 — nothing shipped yet',
      }
    }
    return await publishArtifact(options, projectDir, sessionId, remote)
  } catch (error) {
    return { ...base, status: 'error', reason: (error as Error).message }
  }
}

/**
 * Check that segments tile `[0, watermark)` contiguously in order. Throws with
 * an explicit message on gaps, overlaps, size mismatches, or a watermark that
 * disagrees with the segment list.
 */
function validateSegments(manifest: ShipManifest): void {
  let cursor = 0
  for (const segment of manifest.segments) {
    if (segment.offsetStart !== cursor) {
      throw new Error(
        `segment gap/overlap: expected offset ${cursor}, segment starts at ${segment.offsetStart}`,
      )
    }
    if (
      segment.offsetEnd <= segment.offsetStart ||
      segment.offsetEnd - segment.offsetStart !== segment.bytes
    ) {
      throw new Error(
        `segment ${segment.key}: inconsistent offsets ` +
          `(${segment.offsetStart}-${segment.offsetEnd}, bytes ${segment.bytes})`,
      )
    }
    cursor = segment.offsetEnd
  }
  if (cursor !== manifest.watermark) {
    throw new Error(`segments end at offset ${cursor} but the watermark is ${manifest.watermark}`)
  }
}

/** Download segments in manifest order and concatenate them into the artifact bytes. */
async function downloadSegments(
  store: ListableObjectStore,
  manifest: ShipManifest,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (const segment of manifest.segments) {
    const data = await store.getObject(segment.key)
    if (data === null) throw new Error(`segment ${segment.key} is missing`)
    if (data.length !== segment.bytes) {
      throw new Error(
        `segment ${segment.key} is ${data.length} bytes, manifest says ${segment.bytes}`,
      )
    }
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

/**
 * Compare the remote bytes with the local artifact (if any) and publish
 * accordingly: create / complete / skip / refuse-or-overwrite.
 */
async function publishArtifact(
  options: SyncDownOptions,
  projectDir: string,
  sessionId: string,
  remote: Buffer,
): Promise<SessionSyncResult> {
  const base = { projectDir, sessionId }
  const dir = join(options.root, projectDir, sessionId)
  const target = join(dir, ARTIFACT_NAME)
  const local = await readIfExists(target)

  let prefix = false
  if (local !== null) {
    if (local.equals(remote)) {
      return { ...base, status: 'skipped', bytes: remote.length, reason: 'already in sync' }
    }
    prefix = local.length < remote.length && remote.subarray(0, local.length).equals(local)
    if (!prefix && !options.force) {
      return {
        ...base,
        status: 'conflict',
        bytes: 0,
        reason:
          `local artifact diverged (${local.length} bytes local vs ${remote.length} bytes remote); ` +
          'refusing to overwrite without --force',
      }
    }
  }

  await mkdir(dir, { recursive: true })
  const temp = join(
    dir,
    `.${ARTIFACT_NAME}.sync-down-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  try {
    await writeAndFsync(temp, remote)
    if (local === null) {
      // No-overwrite create: a hard link fails loudly if a writer raced us.
      try {
        await link(temp, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return {
            ...base,
            status: 'conflict',
            bytes: 0,
            reason: `${target} appeared concurrently; left untouched`,
          }
        }
        throw error
      }
      await fsyncDir(dir)
      return { ...base, status: 'restored', bytes: remote.length }
    }
    let backupPath: string | undefined
    if (!prefix) {
      // --force overwrite: park the diverged local artifact first.
      backupPath = `${target}.bak-${Date.now()}`
      await rename(target, backupPath)
    }
    await rename(temp, target)
    await fsyncDir(dir)
    return prefix
      ? { ...base, status: 'appended', bytes: remote.length - local.length }
      : { ...base, status: 'restored', bytes: remote.length, backupPath }
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/** Read a file, or `null` when it does not exist. */
async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Write a file and fsync it before returning (temp-file stage of a publish). */
async function writeAndFsync(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** fsync a directory so the entry created inside it is durable. */
async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
