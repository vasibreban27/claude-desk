import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC, type ChatEvent } from '../../shared/ipc'
import { ChatService } from '../chat/service'
import { sdkRunner } from '../chat/runner'
import { readGitStatus } from '../git/status'
import type { ProjectStore } from '../projects/store'
import { createHandlers } from './handlers'

type EventTarget = Pick<WebContents, 'send' | 'isDestroyed'>

/**
 * Registers all IPC handlers. Chat events are routed only to the window that last
 * sent a message for that project. Returns a function that removes the handlers.
 */
export function registerIpc(store: ProjectStore): () => void {
  const targets = new Map<string, EventTarget>()

  const chat = new ChatService({
    resolveProjectPath: (id) => knownPaths.get(id),
    runner: sdkRunner,
    emit: (event: ChatEvent) => {
      const target = targets.get(event.projectId)
      if (target && !target.isDestroyed()) target.send(IPC.chatEvent, event)
    }
  })

  // The chat service resolves paths synchronously, so keep a cache fed from the store.
  const knownPaths = new Map<string, string>()
  const refreshPaths = async (): Promise<void> => {
    for (const p of await store.list()) knownPaths.set(p.id, p.path)
  }

  const pickFolder = async (event: IpcMainInvokeEvent): Promise<string | undefined> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const first = result.filePaths[0]
    return result.canceled || first === undefined ? undefined : first
  }

  const make = (event: IpcMainInvokeEvent) =>
    createHandlers({ store, readGitStatus, pickFolder: () => pickFolder(event), chat })

  ipcMain.handle(IPC.projectsList, async (event) => {
    const list = await make(event).listProjects()
    for (const p of list) knownPaths.set(p.id, p.path)
    return list
  })
  ipcMain.handle(IPC.projectsPickAndAdd, async (event) => {
    const result = await make(event).pickAndAdd()
    if (result.ok) knownPaths.set(result.project.id, result.project.path)
    return result
  })
  ipcMain.handle(IPC.projectsRefresh, (event, payload: unknown) => make(event).refresh(payload))
  ipcMain.handle(IPC.chatHistory, (event, payload: unknown) => make(event).chatHistory(payload))
  ipcMain.handle(IPC.chatSend, async (event, payload: unknown) => {
    try {
      await refreshPaths()
    } catch (err) {
      console.error('refreshing project paths failed:', err instanceof Error ? err.name : 'unknown')
    }
    return make(event).chatSend(payload, (projectId) => {
      const previous = targets.get(projectId)
      targets.set(projectId, event.sender)
      return () => {
        if (previous) targets.set(projectId, previous)
        else targets.delete(projectId)
      }
    })
  })

  return () => {
    for (const channel of [IPC.projectsList, IPC.projectsPickAndAdd, IPC.projectsRefresh, IPC.chatHistory, IPC.chatSend]) {
      ipcMain.removeHandler(channel)
    }
    targets.clear()
  }
}
