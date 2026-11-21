import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type ActivityEvent,
  type ChatEvent,
  type DeskApi,
  type PipelineEvent,
  type PipelineLogEntry,
  type SpeechProgress,
  type TracePush
} from '../shared/ipc'

/** Minimal typed bridge: each method maps to exactly one contract channel. ipcRenderer is never exposed. */
const api: DeskApi = {
  listProjects: () => ipcRenderer.invoke(IPC.projectsList),
  pickAndAddProject: () => ipcRenderer.invoke(IPC.projectsPickAndAdd),
  refreshProject: (req) => ipcRenderer.invoke(IPC.projectsRefresh, req),
  chatHistory: (req) => ipcRenderer.invoke(IPC.chatHistory, req),
  chatSend: (req) => ipcRenderer.invoke(IPC.chatSend, req),
  activityHistory: (req) => ipcRenderer.invoke(IPC.activityHistory, req),
  activityRuns: (req) => ipcRenderer.invoke(IPC.activityRuns, req),
  activityEvents: (req) => ipcRenderer.invoke(IPC.activityEvents, req),
  onActivityTrace: (listener) => {
    const wrapped = (_e: IpcRendererEvent, push: TracePush): void => listener(push)
    ipcRenderer.on(IPC.activityTrace, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.activityTrace, wrapped)
    }
  },
  usageSummary: (req) => ipcRenderer.invoke(IPC.usageSummary, req),
  usagePlan: (req) => ipcRenderer.invoke(IPC.usagePlan, req),
  settingsGet: (req) => ipcRenderer.invoke(IPC.settingsGet, req),
  settingsSet: (req) => ipcRenderer.invoke(IPC.settingsSet, req),
  settingsSuggestions: (req) => ipcRenderer.invoke(IPC.settingsSuggestions, req),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  appModelGet: () => ipcRenderer.invoke(IPC.appModelGet),
  appModelSet: (req) => ipcRenderer.invoke(IPC.appModelSet, req),
  toolkitList: () => ipcRenderer.invoke(IPC.toolkitList),
  createProject: (req) => ipcRenderer.invoke(IPC.projectsCreate, req),
  projectsRootGet: () => ipcRenderer.invoke(IPC.projectsRootGet),
  projectsRootPick: () => ipcRenderer.invoke(IPC.projectsRootPick),
  removeProject: (req) => ipcRenderer.invoke(IPC.projectsRemove, req),
  pipelinePlans: (req) => ipcRenderer.invoke(IPC.pipelinePlans, req),
  pipelineStart: (req) => ipcRenderer.invoke(IPC.pipelineStart, req),
  pipelineStatus: (req) => ipcRenderer.invoke(IPC.pipelineStatus, req),
  pipelineCancel: (req) => ipcRenderer.invoke(IPC.pipelineCancel, req),
  pipelineResume: (req) => ipcRenderer.invoke(IPC.pipelineResume, req),
  pipelineDiscard: (req) => ipcRenderer.invoke(IPC.pipelineDiscard, req),
  pipelineMerge: (req) => ipcRenderer.invoke(IPC.pipelineMerge, req),
  pipelinePr: (req) => ipcRenderer.invoke(IPC.pipelinePr, req),
  pipelineBranch: (req) => ipcRenderer.invoke(IPC.pipelineBranch, req),
  openUrl: (req) => ipcRenderer.invoke(IPC.openUrl, req),
  mcpList: () => ipcRenderer.invoke(IPC.mcpList),
  mcpSave: (req) => ipcRenderer.invoke(IPC.mcpSave, req),
  mcpDelete: (req) => ipcRenderer.invoke(IPC.mcpDelete, req),
  mcpTest: (req) => ipcRenderer.invoke(IPC.mcpTest, req),
  speechTranscribe: (req) => ipcRenderer.invoke(IPC.speechTranscribe, req),
  agentsView: (req) => ipcRenderer.invoke(IPC.agentsView, req),
  agentsSave: (req) => ipcRenderer.invoke(IPC.agentsSave, req),
  agentsRules: (req) => ipcRenderer.invoke(IPC.agentsRules, req),
  agentsPreview: (req) => ipcRenderer.invoke(IPC.agentsPreview, req),
  onSpeechProgress: (listener) => {
    const wrapped = (_e: IpcRendererEvent, progress: SpeechProgress): void => listener(progress)
    ipcRenderer.on(IPC.speechProgress, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.speechProgress, wrapped)
    }
  },
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
