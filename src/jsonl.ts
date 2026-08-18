/**
 * JSONL artifact format helpers, byte-compatible with the
 * `@deepseek-ai/dsh-session-persistence-jsonl` on-disk layout:
 * the first line is the `type: 'session'` header record, every following
 * line is one serialized {@link SessionEvent} (one event per line, no chunk
 * packing — readers are layout-blind and decode either form).
 *
 * Reimplemented here (not imported) because the published
 * `dsh-session-persistence-jsonl` package loads a native zstd binding
 * (koffi) at import time, which a remote-only sink must not require.
 * Keep in sync with packages/session/session-persistence-jsonl/src/format.ts
 * of the deepseek-harness monorepo (commit noted in README).
 *
 * @module dsh-trajectory-persistence/jsonl
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** The first JSONL record of a session artifact: the immutable header, tagged as a `session` record. */
export interface HeaderLine {
  type: 'session'
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/**
 * Build the header line object from a {@link SessionHeader}.
 * Mirrors `toHeaderLine` of the jsonl persistence backend.
 * @param header - the immutable session metadata to serialize.
 * @returns the `type: 'session'`-tagged line object, absent optional fields omitted.
 */
export function toHeaderLine(header: SessionHeader): HeaderLine {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== undefined ? { seedLength: header.seedLength } : {},
    ...header.origin !== undefined ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  }
}

/**
 * Encode one path segment (session id): safe code units pass through,
 * everything else becomes `~XXXX`. Mirrors `encodeSegment` of the jsonl
 * persistence backend — a {@link SessionId} is an unvalidated branded string
 * and MUST be encoded before use in a key.
 * @param segment - raw path segment.
 * @returns a filesystem/object-key safe segment.
 */
export function encodeSegment(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * Build the readable project key for a project path. Separators become `-`;
 * unsafe code units use the `~XXXX` escape. Mirrors `projectKey` of the jsonl
 * persistence backend; `undefined` cwd selects `_no-cwd`.
 * @param cwd - the session's project directory.
 * @returns a single key-safe project directory name.
 */
export function projectKey(cwd: string | undefined): string {
  if (cwd === undefined) return '_no-cwd'
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Serialize a session artifact part: header line + one JSON event per line,
 * trailing newline. Compatible with `scanLog` readers of the jsonl backend
 * (unpacked layout, one event per line).
 * @param header - session header for the leading header line.
 * @param events - the batch to serialize, in log order.
 * @returns the part's JSONL text.
 */
export function serializePart(header: SessionHeader, events: readonly SessionEvent[]): string {
  const lines = [JSON.stringify(toHeaderLine(header))]
  for (const event of events) lines.push(JSON.stringify(event))
  return lines.join('\n') + '\n'
}
