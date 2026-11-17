import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ActivityEvent, type ChatEvent, type DeskApi } from '../shared/ipc'

/** Minimal typed bridge: each method maps to exactly one contract channel. ipcRenderer is never exposed. */
const api: DeskApi = {
  listProjects: () => ipcRenderer.invoke(IPC.projectsList),
  pickAndAddProject: () => ipcRenderer.invoke(IPC.projectsPickAndAdd),
  refreshProject: (req) => ipcRenderer.invoke(IPC.projectsRefresh, req),
  chatHistory: (req) => ipcRenderer.invoke(IPC.chatHistory, req),
  chatSend: (req) => ipcRenderer.invoke(IPC.chatSend, req),
  activityHistory: (req) => ipcRenderer.invoke(IPC.activityHistory, req),
  usageSummary: (req) => ipcRenderer.invoke(IPC.usageSummary, req),
  settingsGet: (req) => ipcRenderer.invoke(IPC.settingsGet, req),
  settingsSet: (req) => ipcRenderer.invoke(IPC.settingsSet, req),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  onActivityEvent: (listener) => {
    const wrapped = (_e: IpcRendererEvent, event: ActivityEvent): void => listener(event)
    ipcRenderer.on(IPC.activityEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.activityEvent, wrapped)
    }
  },
  onChatEvent: (listener) => {
    const wrapped = (_e: IpcRendererEvent, event: ChatEvent): void => listener(event)
    ipcRenderer.on(IPC.chatEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
