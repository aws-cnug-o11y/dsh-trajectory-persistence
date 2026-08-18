import { describe, expect, it } from 'vitest'
import { withRetry } from '../src/retry.js'

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0
    const result = await withRetry(async () => ++calls, {
      maxRetries: 3,
      baseDelayMs: 1,
      sleep: async () => {},
    })
    expect(result).toBe(1)
    expect(calls).toBe(1)
  })

  it('retries until success and reports each retry', async () => {
    let calls = 0
    const retries: number[] = []
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error(`fail ${calls}`)
        return 'ok'
      },
      {
        maxRetries: 5,
        baseDelayMs: 1,
        sleep: async () => {},
        onRetry: attempt => retries.push(attempt),
      },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(retries).toEqual([1, 2])
  })

  it('throws the last error after exhausting the budget', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error(`boom ${calls}`)
        },
        { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom 3')
    expect(calls).toBe(3) // initial + 2 retries
  })

  it('waits with exponential backoff between attempts', async () => {
    const delays: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 4) throw new Error('fail')
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        sleep: async ms => {
          delays.push(ms)
        },
      },
    )
    expect(delays).toHaveLength(3)
    // 100, 200, 400 plus up to 25% jitter
    expect(delays[0]).toBeGreaterThanOrEqual(100)
    expect(delays[0]).toBeLessThanOrEqual(125)
    expect(delays[1]).toBeGreaterThanOrEqual(200)
    expect(delays[1]).toBeLessThanOrEqual(250)
    expect(delays[2]).toBeGreaterThanOrEqual(400)
    expect(delays[2]).toBeLessThanOrEqual(500)
  })

  it('makes exactly one attempt when maxRetries is 0', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('boom')
        },
        { maxRetries: 0, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('treats a negative maxRetries as zero instead of throwing undefined', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('boom')
        },
        { maxRetries: -1, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('keeps retrying and rethrows the original error when onRetry throws', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error(`boom ${calls}`)
        },
        {
          maxRetries: 2,
          baseDelayMs: 1,
          sleep: async () => {},
          onRetry: () => {
            throw new Error('observer failed')
          },
        },
      ),
    ).rejects.toThrow('boom 3')
    expect(calls).toBe(3)
  })
})
