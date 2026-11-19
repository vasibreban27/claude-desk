import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSISTANT_PROJECT_ID, IPC, type ActivityEvent, type ChatEvent, type PipelineEvent, type PipelineLogEntry } from '../../shared/ipc'
import { ChatService } from '../chat/service'
import { sdkRunner } from '../chat/runner'
import { readGitStatus } from '../git/status'
import { createSettingsStore, type PipelineStore, type RunStore } from '../db'
import { withChangeEvents } from '../db/pipelineStore'
import { createOrchestrator, type Orchestrator } from '../pipeline/orchestrator'
import { createPipelineService, type PipelineService } from '../pipeline/service'
import { createWorkerRunner } from '../pipeline/workerRunner'
import { createPipelineLog, type PipelineLog } from '../pipeline/pipelineLog'
import type { SettingsStore } from '../db/settingsStore'
import type { AppSettings } from '../projects/appSettings'
import { readToolkitInfo } from '../config'
import type { ProjectStore } from '../projects/store'
import { createHandlers } from './handlers'

type EventTarget = Pick<WebContents, 'send' | 'isDestroyed'>

/** Sends a light change signal (ids only) to every open window. */
function broadcastPipelineEvent(event: PipelineEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send(IPC.pipelineEvent, { projectId: event.projectId, runId: event.runId })
  }
}

/**
 * The store emits a change event after each write; the orchestrator is created once (on first use, when the
 * toolkit path is known) with the real worker runner.
 */
function broadcastPipelineLog(entry: PipelineLogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send(IPC.pipelineLogEvent, entry)
  }
}

function buildPipeline(
  rawStore: PipelineStore,
  settings: SettingsStore,
  projects: ProjectStore,
  pipelineLog: PipelineLog
): PipelineService {
  // 4a crash recovery: runs left `running` by a killed app are failed at registration, not on first start.
  try {
    const r = rawStore.markInterrupted()
    if (!r.ok) console.error('pipeline: crash recovery failed')
  } catch {
    console.error('pipeline: crash recovery failed')
  }
  const store = withChangeEvents(rawStore, broadcastPipelineEvent)
  const runner = createWorkerRunner()
  let orchestrator: Orchestrator | undefined
  const lazy: Orchestrator = {
    async startRun(input) {
      if (!orchestrator) {
        const toolkit = readToolkitInfo()
        if (toolkit.status !== 'valid' || toolkit.path === null) return { ok: false, error: 'toolkit is not available' }
        orchestrator = createOrchestrator({
          store,
          settings,
          runner,
          pluginPath: toolkit.path,
          log: (m) => console.error(m),
          onLog: (projectId, line) => pipelineLog.add(projectId, line)
        })
      }
      return orchestrator.startRun(input)
    },
    cancel: (runId) => orchestrator?.cancel(runId) ?? false
  }
  return createPipelineService({
    projects,
    store,
    orchestrator: lazy,
    getToolkit: readToolkitInfo,
    log: (m) => console.error(m)
  })
}

/**
 * Registers all IPC handlers. Chat events are routed only to the window that last
 * sent a message for that project. Returns a function that removes the handlers.
 */
function assistantDir(): string {
  const dir = join(app.getPath('userData'), 'assistant')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function registerIpc(
  store: ProjectStore,
  runStore?: RunStore,
  settingsStore: SettingsStore = createSettingsStore(null),
  pipelineStore?: PipelineStore,
  appSettings?: AppSettings
): () => void {
  const targets = new Map<string, EventTarget>()

  const chat = new ChatService({
    resolveProjectPath: (id) => (id === ASSISTANT_PROJECT_ID ? assistantDir() : knownPaths.get(id)),
    runner: sdkRunner,
    emit: (event: ChatEvent) => {
      const target = targets.get(event.projectId)
      if (target && !target.isDestroyed()) target.send(IPC.chatEvent, event)
    },
    emitActivity: (event: ActivityEvent) => {
      const target = targets.get(event.projectId)
      if (target && !target.isDestroyed()) target.send(IPC.activityEvent, event)
    },
    settings: settingsStore,
    // Plan mode: the planner starts a run when the user says "build it" (pipeline is created below).
    startPipeline: (projectId: string, planFile: string) =>
      pipeline ? pipeline.start(projectId, planFile) : Promise.resolve({ ok: false as const, error: 'start-failed' as const }),
    ...(runStore ? { runStore } : {})
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

  const pipelineLog = createPipelineLog(broadcastPipelineLog)
  const pipeline = pipelineStore ? buildPipeline(pipelineStore, settingsStore, store, pipelineLog) : undefined

  const make = (event: IpcMainInvokeEvent) =>
    createHandlers({ store, readGitStatus, pickFolder: () => pickFolder(event), chat,
      settingsStore,
      readToolkitInfo,
      ...(appSettings ? { appSettings } : {}),
      trash: (folder: string) => shell.trashItem(folder),
      protectedFolders: () => [app.getPath('userData')],
      folderExists: (folder: string) => stat(folder).then((s) => s.isDirectory(), () => false),
      pipelineLog,
      ...(pipeline ? { pipeline } : {}),
      ...(runStore ? { runStore } : {})
    })

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
  ipcMain.handle(IPC.activityHistory, (event, payload: unknown) => make(event).activityHistory(payload))
  ipcMain.handle(IPC.usageSummary, (event, payload: unknown) => make(event).usageSummary(payload))
  ipcMain.handle(IPC.settingsGet, (event, payload: unknown) => make(event).settingsGet(payload))
  ipcMain.handle(IPC.settingsSet, (event, payload: unknown) => make(event).settingsSet(payload))
  ipcMain.handle(IPC.appInfo, (event) => make(event).appInfo())
  ipcMain.handle(IPC.toolkitList, (event) => make(event).toolkitList())
  ipcMain.handle(IPC.projectsCreate, (event, payload: unknown) => make(event).createProject(payload))
  ipcMain.handle(IPC.projectsRootGet, (event) => make(event).projectsRootGet())
  ipcMain.handle(IPC.projectsRootPick, (event) => make(event).projectsRootPick())
  ipcMain.handle(IPC.projectsRemove, async (event, payload: unknown) => {
    const result = await make(event).removeProject(payload)
    if (result.ok && typeof payload === 'object' && payload !== null) knownPaths.delete(String((payload as { id?: unknown }).id))
    return result
  })
  ipcMain.handle(IPC.pipelinePlans, (event, payload: unknown) => make(event).pipelinePlans(payload))
  ipcMain.handle(IPC.pipelineStart, (event, payload: unknown) => make(event).pipelineStart(payload))
  ipcMain.handle(IPC.pipelineStatus, (event, payload: unknown) => make(event).pipelineStatus(payload))
  ipcMain.handle(IPC.pipelineCancel, (event, payload: unknown) => make(event).pipelineCancel(payload))
  ipcMain.handle(IPC.pipelineDiscard, (event, payload: unknown) => make(event).pipelineDiscard(payload))
  ipcMain.handle(IPC.pipelineMerge, (event, payload: unknown) => make(event).pipelineMerge(payload))
  ipcMain.handle(IPC.pipelineLog, (event, payload: unknown) => make(event).pipelineLog(payload))
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
    for (const channel of [IPC.projectsList, IPC.projectsPickAndAdd, IPC.projectsRefresh, IPC.chatHistory, IPC.chatSend, IPC.activityHistory, IPC.usageSummary, IPC.settingsGet, IPC.settingsSet, IPC.appInfo, IPC.toolkitList, IPC.projectsCreate, IPC.projectsRootGet, IPC.projectsRootPick, IPC.projectsRemove,
      IPC.pipelinePlans, IPC.pipelineStart, IPC.pipelineStatus, IPC.pipelineCancel, IPC.pipelineDiscard, IPC.pipelineMerge, IPC.pipelineLog]) {
      ipcMain.removeHandler(channel)
    }
    targets.clear()
  }
}
