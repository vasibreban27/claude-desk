import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import { ChatService } from './service'
import type { ChatRunner, RunnerArgs, RunnerItem } from './runner'

function setup(items: RunnerItem[], found: { planFile: string; problem: string | null }[] = [{ planFile: 'todo-api.md', problem: null }]) {
  const events: ChatEvent[] = []
  const calls: RunnerArgs[] = []
  const runner: ChatRunner = async function* (args) {
    calls.push(args)
    for (const i of items) yield i
  }
  let done: () => void = () => undefined
  const findPlans = vi.fn(async () => found)
  const service = new ChatService({
    resolveProjectPath: () => '/work/one',
    runner,
    emit: (e) => {
      events.push(e)
      if (e.type === 'done' || e.type === 'error') done()
    },
    loadConfig: () => ({ ok: true, config: { toolkitPath: '/toolkit' } }),
    findPlans,
    loadPlanFormat: async () => 'Format: flow-plan/1 ...'
  })
  const turn = (text: string, mode: 'chat' | 'plan') =>
    new Promise<void>((resolve) => {
      done = resolve
      expect(service.send('p1', text, mode).ok).toBe(true)
    })
  return { events, calls, turn, findPlans }
}

describe('ChatService plan mode', () => {
  it('starts the toolkit plan skill on Opus with plan writes, then resumes without the command', async () => {
    const c = setup([{ kind: 'session', sessionId: 's1' }, { kind: 'text', text: 'ok' }])
    await c.turn('build a todo API', 'plan')
    expect(c.calls[0]?.prompt).toBe('/flow:plan build a todo API')
    expect(c.calls[0]?.settings).toMatchObject({ model: 'opus', allowPlanWrites: true })
    expect(c.calls[0]?.appendPrompt).toContain('flow-plan/1')
    await c.turn('accept all recommended', 'plan')
    expect(c.calls[1]?.prompt).toBe('accept all recommended')
    expect(c.calls[1]?.resume).toBe('s1')
  })

  it('emits plan-ready before done for plans written during a planning turn', async () => {
    const c = setup([{ kind: 'text', text: 'written' }], [{ planFile: 'todo-api.md', problem: 'line 3: bad' }])
    await c.turn('go', 'plan')
    expect(c.events).toContainEqual(expect.objectContaining({ type: 'plan-ready', planFile: 'todo-api.md', problem: 'line 3: bad' }))
    expect(c.events.findIndex((e) => e.type === 'plan-ready')).toBeLessThan(c.events.findIndex((e) => e.type === 'done'))
  })

  it('leaves chat mode unchanged: no command, no plan writes, no plan scan', async () => {
    const c = setup([{ kind: 'text', text: 'hi' }])
    await c.turn('what does this repo do', 'chat')
    expect(c.calls[0]?.prompt).toBe('what does this repo do')
    expect(c.calls[0]?.settings?.allowPlanWrites).toBe(false)
    expect(c.calls[0]?.appendPrompt).toBeUndefined()
    expect(c.findPlans).not.toHaveBeenCalled()
  })
})
