import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener }
}))

type Api = Record<string, (...a: unknown[]) => unknown>

async function load(): Promise<Api> {
  await import('./index')
  return exposeInMainWorld.mock.calls[0]![1] as Api
}

describe('preload bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockClear()
    invoke.mockClear()
    on.mockClear()
    removeListener.mockClear()
  })

  it('exposes only the contract methods as window.api, never ipcRenderer', async () => {
    const api = await load()
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld.mock.calls[0]![0]).toBe('api')
    expect(Object.keys(api).sort()).toEqual(
      ['chatHistory', 'chatSend', 'listProjects', 'onChatEvent', 'pickAndAddProject', 'refreshProject'].sort()
    )
    expect(Object.values(api).every((v) => typeof v === 'function')).toBe(true)
  })

  it('maps methods to the contract channels', async () => {
    const api = await load()
    await api['listProjects']!()
    await api['pickAndAddProject']!()
    await api['refreshProject']!({ id: 'a' })
    await api['chatHistory']!({ projectId: 'a' })
    await api['chatSend']!({ projectId: 'a', text: 'x' })
    expect(invoke.mock.calls).toEqual([
      ['projects:list'],
      ['projects:pick-and-add'],
      ['projects:refresh', { id: 'a' }],
      ['chat:history', { projectId: 'a' }],
      ['chat:send', { projectId: 'a', text: 'x' }]
    ])
  })

  it('subscribes without leaking the IPC event, and unsubscribes', async () => {
    const api = await load()
    const listener = vi.fn()
    const off = api['onChatEvent']!(listener) as () => void
    expect(on).toHaveBeenCalledWith('chat:event', expect.any(Function))
    const wrapped = on.mock.calls[0]![1] as (e: unknown, ev: unknown) => void
    wrapped({ sender: 'leak' }, { type: 'done' })
    expect(listener).toHaveBeenCalledWith({ type: 'done' })
    off()
    expect(removeListener).toHaveBeenCalledWith('chat:event', wrapped)
  })
})
