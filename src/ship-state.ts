/**
 * Local ship-mode state: per-session upload progress persisted as one JSON
 * document at `<stateDir>/ship-state.json` (atomic temp+rename writes), so a
 * restart resumes at the last uploaded watermark instead of re-shipping.
 *
 * The state is advisory, never authoritative: the S3 `_manifest.json`
 * watermark wins on disagreement, and the size-regression check
 * ({@link updateSessionState}) only flags `conflicted` for the shipper to
 * resolve against the manifest.
 *
 * @module dsh-trajectory-persistence/ship-state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** File name of the persisted state document inside the state directory. */
export const SHIP_STATE_FILE = 'ship-state.json'

/** Default local state directory (overridable by injection for tests). */
export function defaultShipStateDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'trajectory-persistence')
}

/** Per-session ship progress. */
export interface SessionShipState {
  /** Exclusive byte offset durably uploaded (mirrors the manifest watermark). */
  uploadedOffset: number
  /** Artifact size in bytes at the last poll. */
  lastSize: number
  /** Artifact mtime in nanoseconds at the last poll (change detection). */
  lastMtimeNs: number
  /** True once the artifact was stable (unchanged size+mtime) past dormantAfterMs. */
  dormant: boolean
  /** True after a size regression (`lastSize < uploadedOffset`); watermark untouched. */
  conflicted: boolean
}

/** Whole persisted state document: session id (as encoded in keys) → progress. */
export interface ShipState {
  version: 1
  sessions: Record<string, SessionShipState>
}

/** Fresh session progress at offset zero. */
export function initialSessionState(): SessionShipState {
  return { uploadedOffset: 0, lastSize: 0, lastMtimeNs: 0, dormant: false, conflicted: false }
}

function emptyState(): ShipState {
  return { version: 1, sessions: {} }
}

function statePath(dir: string): string {
  return join(dir, SHIP_STATE_FILE)
}

/**
 * Load the persisted state, returning an empty document when none exists.
 * @param dir - state directory.
 * @returns the persisted ship state.
 * @throws on a present but unreadable/corrupt state file (fail loud; the
 *   shipper must not silently restart from zero and re-upload).
 */
export async function loadShipState(dir: string): Promise<ShipState> {
  let text: string
  try {
    text = await readFile(statePath(dir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  const value = JSON.parse(text) as ShipState
  if (value.version !== 1) {
    throw new Error(`unsupported ship-state version ${String(value.version)} (expected 1)`)
  }
  return value
}

/**
 * Persist the state atomically: write a temp sibling, then rename over the
 * target so a crash never leaves a half-written document.
 * @param dir - state directory (created when missing).
 * @param state - state document to persist.
 */
export async function saveShipState(dir: string, state: ShipState): Promise<void> {
  await mkdir(dir, { recursive: true })
  const temp = `${statePath(dir)}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(temp, statePath(dir))
}

/**
 * Read one session's progress, or `undefined` for a session never seen.
 * @param state - loaded state document.
 * @param sessionId - encoded session id.
 * @returns the session's progress.
 */
export function getSessionState(state: ShipState, sessionId: string): SessionShipState | undefined {
  return state.sessions[sessionId]
}

/**
 * Apply a poll observation to one session's progress in place. A size
 * regression (`size < uploadedOffset`) means the artifact was replaced or
 * truncated underneath us: mark the session `conflicted` and leave
 * `uploadedOffset` untouched (the manifest watermark still holds those bytes);
 * the shipper resolves the conflict before shipping further.
 * @param state - loaded state document (mutated).
 * @param sessionId - encoded session id.
 * @param observed - current artifact observation.
 * @returns the updated session progress.
 */
export function updateSessionState(
  state: ShipState,
  sessionId: string,
  observed: { size: number; mtimeNs: number; dormant?: boolean },
): SessionShipState {
  const current = state.sessions[sessionId] ?? initialSessionState()
  const next: SessionShipState = {
    ...current,
    lastSize: observed.size,
    lastMtimeNs: observed.mtimeNs,
    ...observed.dormant !== undefined ? { dormant: observed.dormant } : {},
  }
  if (observed.size < current.uploadedOffset) next.conflicted = true
  state.sessions[sessionId] = next
  return next
}

/**
 * Record a successful upload advance (the only writer of `uploadedOffset`
 * besides conflict resolution). Also clears `conflicted` — advancing the
 * watermark is the resolution.
 * @param state - loaded state document (mutated).
 * @param sessionId - encoded session id.
 * @param uploadedOffset - new exclusive uploaded offset (must not regress).
 * @returns the updated session progress.
 */
export function advanceSessionOffset(state: ShipState, sessionId: string, uploadedOffset: number): SessionShipState {
  const current = state.sessions[sessionId] ?? initialSessionState()
  if (uploadedOffset < current.uploadedOffset) {
    throw new Error(
      `ship offset regression for session ${sessionId}: ${uploadedOffset} < ${current.uploadedOffset}`,
    )
  }
  const next: SessionShipState = { ...current, uploadedOffset, conflicted: false }
  state.sessions[sessionId] = next
  return next
}
