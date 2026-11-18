import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../../shared/ipc'

type Handler = (event: unknown, payload?: unknown) => unknown
const handlers = new Map<string, Handler>()
let capturedEmitActivity: ((e: ActivityEvent) => void) | undefined
let capturedSettings: unknown
let chatSendRegister: ((projectId: string) => () => void) | undefined
let windows: unknown[] = []
let capturedStoreEmit: ((e: { projectId: string; runId: string }) => void) | undefined

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => windows },
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
vi.mock('../db/pipelineStore', () => ({
  withChangeEvents: (inner: unknown, emit: (e: { projectId: string; runId: string }) => void) => {
    capturedStoreEmit = emit
    return inner
  }
}))
vi.mock('../pipeline/workerRunner', () => ({ createWorkerRunner: vi.fn(() => vi.fn()) }))
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
import type { PipelineStore } from '../db'
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

  it('registers the pipeline channels, removes them on dispose and broadcasts ids only to live windows', () => {
    const live = { isDestroyed: () => false, webContents: sender() }
    const deadWin = { isDestroyed: () => true, webContents: sender() }
    const deadContents = { isDestroyed: () => false, webContents: sender(true) }
    windows = [live, deadWin, deadContents]
    const dispose = registerIpc(store, undefined, undefined, {} as unknown as PipelineStore)
    for (const c of [IPC.pipelinePlans, IPC.pipelineStart, IPC.pipelineStatus, IPC.pipelineCancel, IPC.pipelineDiscard]) {
      expect(handlers.has(c)).toBe(true)
    }
    capturedStoreEmit?.({ projectId: 'p1', runId: 'r1', extra: 'x' } as never)
    expect(live.webContents.send).toHaveBeenCalledWith(IPC.pipelineEvent, { projectId: 'p1', runId: 'r1' })
    expect(deadWin.webContents.send).not.toHaveBeenCalled()
    expect(deadContents.webContents.send).not.toHaveBeenCalled()
    dispose()
    expect(handlers.size).toBe(0)
    windows = []
  })

  it('marks interrupted runs once at registration, without any start, and never throws', () => {
    const ok = { markInterrupted: vi.fn(() => ({ ok: true as const, value: 1 })) }
    registerIpc(store, undefined, undefined, ok as unknown as PipelineStore)()
    expect(ok.markInterrupted).toHaveBeenCalledTimes(1)

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = { markInterrupted: vi.fn(() => ({ ok: false as const, error: 'storage-error' })) }
    expect(() => registerIpc(store, undefined, undefined, failing as unknown as PipelineStore)()).not.toThrow()
    const throwing = {
      markInterrupted: vi.fn(() => {
        throw new Error('C:\\secret\\path')
      })
    }
    expect(() => registerIpc(store, undefined, undefined, throwing as unknown as PipelineStore)()).not.toThrow()
    expect(err).toHaveBeenCalledTimes(2)
    expect(err).toHaveBeenCalledWith('pipeline: crash recovery failed')
    err.mockRestore()
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
