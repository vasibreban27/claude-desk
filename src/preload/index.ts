import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ChatEvent, type DeskApi } from '../shared/ipc'

/** Minimal typed bridge: each method maps to exactly one contract channel. ipcRenderer is never exposed. */
const api: DeskApi = {
  listProjects: () => ipcRenderer.invoke(IPC.projectsList),
  pickAndAddProject: () => ipcRenderer.invoke(IPC.projectsPickAndAdd),
  refreshProject: (req) => ipcRenderer.invoke(IPC.projectsRefresh, req),
  chatHistory: (req) => ipcRenderer.invoke(IPC.chatHistory, req),
  chatSend: (req) => ipcRenderer.invoke(IPC.chatSend, req),
  onChatEvent: (listener) => {
    const wrapped = (_e: IpcRendererEvent, event: ChatEvent): void => listener(event)
    ipcRenderer.on(IPC.chatEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
