import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'

/** Minimal cordis Context stub: the sinks only use `ctx.logger()`. */
export function fakeCtx(): Context {
  const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
  return { logger: () => logger } as unknown as Context
}

export function fakeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 1,
    id: 'sess-1' as SessionHeader['id'],
    createdAt: 1_700_000_000_000,
    cwd: '/repo/my-project',
    ...overrides,
  }
}

export function fakeSession(header: SessionHeader = fakeHeader()): Session {
  return { id: header.id, header } as unknown as Session
}

let time = 1_700_000_100_000

export function ev<T extends SessionEventType>(type: T, seq: number, data: SessionEventMap[T]): SessionEvent<T> {
  time += 10
  return { type, seq, time, data } as SessionEvent<T>
}

export function resetClock(): void {
  time = 1_700_000_100_000
}
