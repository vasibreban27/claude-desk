import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type ActivityEvent,
  type ChatEvent,
  type DeskApi,
  type PipelineEvent,
  type PipelineLogEntry
} from '../shared/ipc'

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
  toolkitList: () => ipcRenderer.invoke(IPC.toolkitList),
  createProject: (req) => ipcRenderer.invoke(IPC.projectsCreate, req),
  projectsRootGet: () => ipcRenderer.invoke(IPC.projectsRootGet),
  projectsRootPick: () => ipcRenderer.invoke(IPC.projectsRootPick),
  removeProject: (req) => ipcRenderer.invoke(IPC.projectsRemove, req),
  pipelinePlans: (req) => ipcRenderer.invoke(IPC.pipelinePlans, req),
  pipelineStart: (req) => ipcRenderer.invoke(IPC.pipelineStart, req),
  pipelineStatus: (req) => ipcRenderer.invoke(IPC.pipelineStatus, req),
  pipelineCancel: (req) => ipcRenderer.invoke(IPC.pipelineCancel, req),
  pipelineDiscard: (req) => ipcRenderer.invoke(IPC.pipelineDiscard, req),
  pipelineMerge: (req) => ipcRenderer.invoke(IPC.pipelineMerge, req),
  pipelineLog: (req) => ipcRenderer.invoke(IPC.pipelineLog, req),
  onPipelineLog: (listener) => {
    const wrapped = (_e: IpcRendererEvent, entry: PipelineLogEntry): void => listener(entry)
    ipcRenderer.on(IPC.pipelineLogEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.pipelineLogEvent, wrapped)
    }
  },
  onPipelineEvent: (listener) => {
    const wrapped = (_e: IpcRendererEvent, event: PipelineEvent): void => listener(event)
    ipcRenderer.on(IPC.pipelineEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.pipelineEvent, wrapped)
    }
  },
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
