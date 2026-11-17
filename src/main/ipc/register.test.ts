import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../../shared/ipc'

type Handler = (event: unknown, payload?: unknown) => unknown
const handlers = new Map<string, Handler>()
let capturedEmitActivity: ((e: ActivityEvent) => void) | undefined
let capturedSettings: unknown
let chatSendRegister: ((projectId: string) => () => void) | undefined

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`)
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

vi.mock('../chat/service', () => ({
  ChatService: class {
    constructor(deps: { emitActivity: (e: ActivityEvent) => void; settings?: unknown }) {
      capturedEmitActivity = deps.emitActivity
      capturedSettings = deps.settings
    }
  }
}))
vi.mock('../chat/runner', () => ({ sdkRunner: vi.fn() }))
vi.mock('../git/status', () => ({ readGitStatus: vi.fn() }))
vi.mock('./handlers', () => ({
  createHandlers: () => ({
    chatSend: (_payload: unknown, register: (projectId: string) => () => void) => {
      chatSendRegister = register
      register('p1')
      return { ok: true }
    }
  })
}))

import { IPC } from '../../shared/ipc'
import type { ProjectStore } from '../projects/store'
import { registerIpc } from './register'

const store = { list: async () => [] } as unknown as ProjectStore

function sender(destroyed = false) {
  return { send: vi.fn(), isDestroyed: () => destroyed }
}

const activity = { projectId: 'p1' } as unknown as ActivityEvent

async function sendFrom(s: ReturnType<typeof sender>): Promise<void> {
  await handlers.get(IPC.chatSend)?.({ sender: s }, {})
}

describe('registerIpc', () => {
  beforeEach(() => {
    handlers.clear()
    capturedEmitActivity = undefined
    chatSendRegister = undefined
  })

  it('routes activity events only to the last sender for the project', async () => {
    const dispose = registerIpc(store)
    const a = sender()
    const b = sender()
    await sendFrom(a)
    await sendFrom(b)
    capturedEmitActivity?.(activity)
    expect(b.send).toHaveBeenCalledWith(IPC.activityEvent, activity)
    expect(a.send).not.toHaveBeenCalled()
    capturedEmitActivity?.({ projectId: 'other' } as unknown as ActivityEvent)
    expect(b.send).toHaveBeenCalledTimes(1)
    expect(chatSendRegister).toBeDefined()
    dispose()
  })

  it('passes the settings store to ChatService and registers the settings channels', () => {
    const settings = { get: vi.fn(), set: vi.fn() }
    const dispose = registerIpc(store, undefined, settings)
    expect(capturedSettings).toBe(settings)
    for (const c of [IPC.settingsGet, IPC.settingsSet, IPC.appInfo]) expect(handlers.has(c)).toBe(true)
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('uses an unavailable settings store by default', () => {
    const dispose = registerIpc(store)
    expect(capturedSettings).toBeDefined()
    dispose()
  })

  it('skips destroyed WebContents', async () => {
    const dispose = registerIpc(store)
    const dead = sender(true)
    await sendFrom(dead)
    capturedEmitActivity?.(activity)
    expect(dead.send).not.toHaveBeenCalled()
    dispose()
  })

  it('dispose removes every handler, and registering again does not throw', () => {
    const dispose = registerIpc(store)
    expect(handlers.has(IPC.activityHistory)).toBe(true)
    expect(handlers.has(IPC.usageSummary)).toBe(true)
    dispose()
    expect(handlers.size).toBe(0)
    expect(() => registerIpc(store)()).not.toThrow()
    expect(handlers.size).toBe(0)
  })
})
