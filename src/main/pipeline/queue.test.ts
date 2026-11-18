import { describe, expect, it } from 'vitest'
import { createMutex, runPool } from './queue'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createMutex', () => {
  it('runs functions one at a time in call order and continues after a rejection', async () => {
    const mutex = createMutex()
    const log: string[] = []
    let inside = 0
    const job = (name: string, fail = false) => async (): Promise<string> => {
      inside += 1
      expect(inside).toBe(1)
      log.push(`start ${name}`)
      await tick()
      log.push(`end ${name}`)
      inside -= 1
      if (fail) throw new Error(name)
      return name
    }
    const a = mutex(job('a'))
    const b = mutex(job('b', true))
    const c = mutex(job('c'))
    expect(await a).toBe('a')
    await expect(b).rejects.toThrow('b')
    expect(await c).toBe('c')
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })
})

describe('runPool', () => {
  it('caps concurrency, starts in item order and resolves when all settled', async () => {
    const started: number[] = []
    let running = 0
    let max = 0
    const gates = new Map<number, () => void>()
    const p = runPool([1, 2, 3, 4], 2, async (n) => {
      started.push(n)
      running += 1
      max = Math.max(max, running)
      await new Promise<void>((resolve) => gates.set(n, resolve))
      running -= 1
    })
    await tick()
    expect(started).toEqual([1, 2])
    gates.get(2)?.()
    await tick()
    expect(started).toEqual([1, 2, 3])
    gates.get(1)?.()
    await tick()
    gates.get(3)?.()
    gates.get(4)?.()
    await p
    expect(started).toEqual([1, 2, 3, 4])
    expect(max).toBe(2)
  })

  it('does not reject when fn throws and still runs the rest', async () => {
    const seen: number[] = []
    await expect(
      runPool([1, 2, 3], 1, async (n) => {
        seen.push(n)
        if (n === 1) throw new Error('x')
      })
    ).resolves.toBeUndefined()
    expect(seen).toEqual([1, 2, 3])
  })

  it('handles an empty list and a limit below 1', async () => {
    await runPool([], 3, async () => undefined)
    const seen: number[] = []
    await runPool([1, 2], 0, async (n) => void seen.push(n))
    expect(seen).toEqual([1, 2])
  })
})
