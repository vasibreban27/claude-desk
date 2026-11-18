/** Small concurrency helpers for the pipeline scheduler. */

/** Runs the queued async functions one at a time, in call order; a rejection does not block the next one. */
export type Mutex = <T>(fn: () => Promise<T>) => Promise<T>

export function createMutex(): Mutex {
  // `tail` never rejects, so a failed function cannot poison the queue.
  let tail: Promise<void> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Runs `fn` for every item with at most `limit` running at once, starting items in order. Resolves when all
 * have settled and never rejects: `fn` is expected to handle its own errors (a throw is swallowed).
 */
export async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T
      try {
        await fn(item)
      } catch {
        // fn owns its error handling; one failing item must not stop its siblings
      }
    }
  }
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
}
