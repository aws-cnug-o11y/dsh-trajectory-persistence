import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  advanceSessionOffset,
  defaultShipStateDir,
  getSessionState,
  initialSessionState,
  loadShipState,
  saveShipState,
  updateSessionState,
  type ShipState,
} from '../src/ship-state.js'

function emptyState(): ShipState {
  return { version: 1, sessions: {} }
}

describe('loadShipState / saveShipState', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ship-state-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty document when no state file exists', async () => {
    expect(await loadShipState(dir)).toEqual({ version: 1, sessions: {} })
  })

  it('round-trips a persisted state', async () => {
    const state = emptyState()
    updateSessionState(state, 'sess-1', { size: 100, mtimeNs: 7 })
    advanceSessionOffset(state, 'sess-1', 64)
    await saveShipState(dir, state)
    expect(await loadShipState(dir)).toEqual(state)
  })

  it('writes atomically (no temp file left behind)', async () => {
    await saveShipState(dir, emptyState())
    const names = (await import('node:fs/promises')).readdir(dir)
    expect(await names).toEqual(['ship-state.json'])
    expect(JSON.parse(await readFile(join(dir, 'ship-state.json'), 'utf8'))).toEqual(emptyState())
  })

  it('rejects a corrupt state file loudly', async () => {
    await writeFile(join(dir, 'ship-state.json'), '{nope')
    await expect(loadShipState(dir)).rejects.toThrow()
  })

  it('rejects a foreign state version', async () => {
    await writeFile(join(dir, 'ship-state.json'), JSON.stringify({ version: 2, sessions: {} }))
    await expect(loadShipState(dir)).rejects.toThrow(/unsupported ship-state version 2/)
  })
})

describe('defaultShipStateDir', () => {
  it('uses DSH_HOME when set', () => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = '/custom/dsh'
    try {
      expect(defaultShipStateDir()).toBe('/custom/dsh/trajectory-persistence')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

describe('session progress', () => {
  it('starts unseen sessions at zero', () => {
    const state = emptyState()
    expect(getSessionState(state, 'nope')).toBeUndefined()
    expect(initialSessionState()).toEqual({
      uploadedOffset: 0, lastSize: 0, lastMtimeNs: 0, dormant: false, conflicted: false,
    })
  })

  it('records poll observations and dormant transitions', () => {
    const state = emptyState()
    const s = updateSessionState(state, 's1', { size: 10, mtimeNs: 1, dormant: true })
    expect(s).toMatchObject({ lastSize: 10, lastMtimeNs: 1, dormant: true })
    const s2 = updateSessionState(state, 's1', { size: 20, mtimeNs: 2 })
    expect(s2.dormant).toBe(true) // dormant flag preserved unless re-specified
    expect(s2.lastSize).toBe(20)
  })

  it('flags conflicted on a size regression without moving the watermark', () => {
    const state = emptyState()
    advanceSessionOffset(state, 's1', 262144)
    const s = updateSessionState(state, 's1', { size: 100, mtimeNs: 9 })
    expect(s.conflicted).toBe(true)
    expect(s.uploadedOffset).toBe(262144)
  })

  it('does not flag conflicted at exactly the watermark', () => {
    const state = emptyState()
    advanceSessionOffset(state, 's1', 100)
    const s = updateSessionState(state, 's1', { size: 100, mtimeNs: 1 })
    expect(s.conflicted).toBe(false)
  })

  it('advanceSessionOffset refuses a regression and clears conflicted on advance', () => {
    const state = emptyState()
    advanceSessionOffset(state, 's1', 100)
    updateSessionState(state, 's1', { size: 50, mtimeNs: 1 })
    expect(getSessionState(state, 's1')!.conflicted).toBe(true)
    expect(() => advanceSessionOffset(state, 's1', 99)).toThrow(/offset regression/)
    const s = advanceSessionOffset(state, 's1', 200)
    expect(s.uploadedOffset).toBe(200)
    expect(s.conflicted).toBe(false)
  })
})
