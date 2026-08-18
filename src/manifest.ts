/**
 * Ship-mode S3 manifest: per-session `_manifest.json` tracking the uploaded
 * watermark and segment list, plus the stable machine identity (`writerId`)
 * used to detect two writers shipping the same session.
 *
 * Object layout (shared with the shipper and sync-down):
 *
 *     {prefix}/{projectDir}/{sessionId}/{offsetStart}-{offsetEnd}.jsonl.zstd
 *     {prefix}/{projectDir}/{sessionId}/_manifest.json
 *
 * `projectDir` and `sessionId` are the already-encoded key segments produced
 * by `projectKey` / `encodeSegment` in `./jsonl.js`.
 *
 * @module dsh-trajectory-persistence/manifest
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Manifest format version; readers refuse any other value. */
export const MANIFEST_VERSION = 1

/** One uploaded segment: a byte range of the local artifact, uploaded as one object. */
export interface ManifestSegment {
  /** Full object key of the segment. */
  key: string
  /** Inclusive byte offset in the session artifact. */
  offsetStart: number
  /** Exclusive byte offset in the session artifact. */
  offsetEnd: number
  /** Uploaded byte count (`offsetEnd - offsetStart`). */
  bytes: number
  /** ISO-8601 completion time of the upload. */
  uploadedAt: string
}

/** Per-session `_manifest.json` content. */
export interface ShipManifest {
  version: number
  sessionId: string
  format: {
    kind: 'jsonl.zstd'
    /** `SESSION_FORMAT_VERSION` of the artifact producer. */
    sessionFormatVersion: number
  }
  /** Stable per-machine identity of the writer that owns this manifest. */
  writerId: string
  /** Exclusive byte offset up to which the artifact is durably uploaded. */
  watermark: number
  segments: ManifestSegment[]
  /** ISO-8601 time of the last manifest write. */
  updatedAt: string
}

/**
 * Minimal object-store seam for manifest I/O: `getObject` returns `null` for a
 * missing key. Implemented by the AWS SDK wrapper, mocked in tests.
 */
export interface ObjectStore {
  getObject(key: string): Promise<Buffer | null>
  putObject(key: string, body: Buffer | string): Promise<void>
}

/**
 * Build the object key of one segment. Offsets are zero-padded to 14 decimal
 * digits so lexicographic listing order matches byte order.
 * @param offsetStart - inclusive byte offset of the segment.
 * @param offsetEnd - exclusive byte offset of the segment.
 * @returns the segment's object key relative to the session directory.
 */
export function segmentKey(offsetStart: number, offsetEnd: number): string {
  const start = String(offsetStart).padStart(14, '0')
  const end = String(offsetEnd).padStart(14, '0')
  return `${start}-${end}.jsonl.zstd`
}

/**
 * Build the full object key of a session's manifest.
 * @param prefix - configured key prefix (leading/trailing slashes trimmed).
 * @param projectDir - encoded project directory segment.
 * @param sessionId - encoded session id segment.
 * @returns the manifest's object key.
 */
export function manifestKey(prefix: string, projectDir: string, sessionId: string): string {
  const clean = prefix.replace(/^\/+|\/+$/g, '')
  const base = `${projectDir}/${sessionId}/_manifest.json`
  return clean ? `${clean}/${base}` : base
}

/** Thrown when persisted JSON is not a manifest of the supported version. */
export class ManifestError extends Error {}

/**
 * Parse manifest JSON, refusing structurally valid JSON of another version.
 * @param json - raw `_manifest.json` text.
 * @returns the parsed manifest.
 * @throws {@link ManifestError} on malformed JSON, shape, or version.
 */
export function parseManifest(json: string): ShipManifest {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new ManifestError(`manifest is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError('manifest must be a JSON object')
  }
  const manifest = value as ShipManifest
  if (manifest.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `unsupported manifest version ${String(manifest.version)} (expected ${MANIFEST_VERSION})`,
    )
  }
  return manifest
}

/**
 * Serialize a manifest with stable field order for readable diffs.
 * @param manifest - the manifest to persist.
 * @returns the `_manifest.json` text.
 */
export function serializeManifest(manifest: ShipManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * Read a session's manifest, or `null` when none exists yet.
 * @param store - object-store seam.
 * @param key - full manifest key (see {@link manifestKey}).
 * @returns the parsed manifest, or `null` for a first-time session.
 */
export async function readManifest(store: ObjectStore, key: string): Promise<ShipManifest | null> {
  const body = await store.getObject(key)
  if (body === null) return null
  return parseManifest(body.toString('utf8'))
}

/**
 * Write a manifest, stamping `updatedAt`.
 * @param store - object-store seam.
 * @param key - full manifest key.
 * @param manifest - manifest to persist.
 */
export async function writeManifest(store: ObjectStore, key: string, manifest: ShipManifest): Promise<void> {
  await store.putObject(key, serializeManifest({ ...manifest, updatedAt: new Date().toISOString() }))
}

/** Compare two manifests ignoring the `updatedAt` stamp. */
function sameManifest(a: ShipManifest, b: ShipManifest): boolean {
  // Field order survives the JSON round-trip because both sides come from
  // `serializeManifest`.
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' })
}

/**
 * Read-modify-write a session's manifest. `mutate` receives the current
 * manifest (`null` on first contact) and returns the successor. Object stores
 * have no conditional put, so a race with another writer is detected after
 * the fact: the manifest is re-read once written, and when another writer's
 * version landed instead, `mutate` is re-applied on top of it and written
 * once more (exactly one conflict retry; a second lost race surfaces as the
 * returned manifest, and callers detect foreign ownership via `writerId`).
 * @param store - object-store seam.
 * @param key - full manifest key.
 * @param mutate - pure transition from current to next manifest.
 * @returns the manifest that was last written.
 */
export async function updateManifest(
  store: ObjectStore,
  key: string,
  mutate: (current: ShipManifest | null) => ShipManifest,
): Promise<ShipManifest> {
  let next = mutate(await readManifest(store, key))
  await writeManifest(store, key, next)
  const settled = await readManifest(store, key)
  if (settled !== null && sameManifest(settled, next)) return next
  next = mutate(settled)
  await writeManifest(store, key, next)
  return next
}

const WRITER_ID_FILE = 'writer-id'

/**
 * Resolve this machine's stable writer id: `<hostname>-<random suffix>`,
 * persisted at `<stateDir>/writer-id` so restarts and plugin reloads reuse it.
 * @param stateDir - local ship-state directory (created when missing).
 * @returns the stable writer id.
 */
export async function getOrCreateWriterId(stateDir: string): Promise<string> {
  const path = join(stateDir, WRITER_ID_FILE)
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing) return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const id = `${hostname()}-${platform()}-${randomBytes(4).toString('hex')}`
  await mkdir(stateDir, { recursive: true })
  await writeFile(path, id + '\n', 'utf8')
  return id
}
