/**
 * Exponential-backoff retry helper shared by the sinks.
 *
 * @module dsh-trajectory-persistence/retry
 */

export interface RetryOptions {
  /** Number of retries after the first attempt (total attempts = maxRetries + 1). */
  maxRetries: number
  /** Base delay in milliseconds; attempt `n` waits `baseDelayMs * 2^(n-1)` plus jitter. */
  baseDelayMs: number
  /** Optional failure observer (logging hook). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run `task` until it succeeds or the retry budget is exhausted.
 * Delays grow exponentially from `baseDelayMs` with up to 25% jitter.
 * @param task - the fallible operation.
 * @param options - retry budget, base delay, and hooks.
 * @returns the task's result.
 * @throws the last error once all attempts failed.
 */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const maxRetries = Math.max(0, options.maxRetries)
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt === maxRetries) break
      // Cap the exponent so the delay stays below setTimeout's 2^31-1 ms limit.
      const delay = Math.round(
        options.baseDelayMs * 2 ** Math.min(attempt, 20) * (1 + Math.random() * 0.25),
      )
      try {
        options.onRetry?.(attempt + 1, error, delay)
      } catch {
        // A failing observer must not mask the original error or stop retrying.
      }
      await sleep(delay)
    }
  }
  throw lastError
}
