import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMode } from '@shared/ipc'
import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { PlanReadyCard } from './components/Chat/PlanReadyCard'
import { Workspace, WORKSPACE_TAB_KEY } from './components/Workspace'
import { SettingsPanel } from './components/Settings'
import { useProjects } from './hooks/useProjects'
import { useChat, type UseChat } from './hooks/useChat'
import { useStartProject } from './hooks/useStartProject'
import './styles/layout.css'

function showPipelineTab(): void {
  try {
    localStorage.setItem(WORKSPACE_TAB_KEY, 'pipeline')
  } catch {
    // the tab is a convenience
  }
}

const NEW_PROJECT_PLACEHOLDER = 'Describe a new app: a project is created and the planner (Opus) starts'
const NEW_PROJECT_EMPTY =
  'Start a new project: describe what to build. The app creates a git project for it in your projects folder and the toolkit planner (flow:plan, Opus) takes it from there. To work on an existing repository, use Add project.'
const PLAN_PLACEHOLDER = 'Describe what to build: the toolkit planner (Opus) writes the plan'

export function App() {
  const projects = useProjects()
  /** The user chose "New project": the chat starts a project even while one is selected. */
  const [newChat, setNewChat] = useState(false)
  /** Chat or Plan (toolkit planner) per project; Plan is the default for projects started from the chat. */
  const [modes, setModes] = useState<Record<string, ChatMode>>({})
  /** Bumped to remount the workspace on the Pipeline tab. */
  const [workspaceKey, setWorkspaceKey] = useState(0)
  const starter = useStartProject()
  /** The first message of a project started from the chat, sent once its chat has loaded. */
  const firstMessage = useRef<{ projectId: string; text: string } | null>(null)

  const selected = newChat ? null : projects.selectedId
  const mode: ChatMode = selected !== null ? (modes[selected] ?? 'chat') : 'chat'
  const chat = useChat(selected, mode)
  // "build it" in the Plan chat started a run: show it.
  const startedRun = chat.pipelineStarted?.runId ?? null
  const [shownRun, setShownRun] = useState<string | null>(null)
  if (startedRun !== null && startedRun !== shownRun) {
    // Adjusting state during render (React's pattern for reacting to a changed value): remount on the Pipeline tab.
    setShownRun(startedRun)
    showPipelineTab()
    setWorkspaceKey((k) => k + 1)
  }

  // Send the first message through the project's own chat, after its (empty) history loaded, so it shows normally.
  const { loading: chatLoading, send: chatSend } = chat
  useEffect(() => {
    const first = firstMessage.current
    if (first === null || first.projectId !== selected || chatLoading) return
    firstMessage.current = null
    void chatSend(first.text)
  }, [selected, chatLoading, chatSend])

  const projectNames = useMemo(
    () => Object.fromEntries(projects.projects.map((p) => [p.id, p.name])),
    [projects.projects]
  )

  /** No project: the first message creates one named from it and opens it in Plan mode with that message. */
  async function startProject(text: string) {
    const project = await starter.start(text)
    if (project === null) return
    firstMessage.current = { projectId: project.id, text }
    setModes((m) => ({ ...m, [project.id]: 'plan' }))
    projects.adopt(project)
    setNewChat(false)
  }

  const startChat: UseChat = {
    messages: [],
    loading: false,
    busy: starter.starting,
    error: starter.error,
    send: startProject,
    planReady: null,
    clearPlanReady: () => undefined,
    pipelineStarted: null
  }

  return (
    <Layout
      projects={
        <ProjectsPanel
          {...projects}
          selectedId={selected}
          onNewProject={() => setNewChat(true)}
          add={async () => {
            setNewChat(false)
            await projects.add()
          }}
          select={async (id) => {
            setNewChat(false)
            await projects.select(id)
          }}
        />
      }
      workspace={
        selected !== null ? <Workspace key={`${selected}:${workspaceKey}`} projectId={selected} projectNames={projectNames} /> : <SettingsPanel projectId={null} />
      }
      chat={
        selected === null ? (
          <ChatPanel {...startChat} hasProject placeholder={NEW_PROJECT_PLACEHOLDER} emptyText={NEW_PROJECT_EMPTY} />
        ) : (
          <>
            <div className="chat__modes" role="radiogroup" aria-label="Chat mode">
              {(['chat', 'plan'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setModes((all) => ({ ...all, [selected]: m }))}
                >
                  {m === 'chat' ? 'Chat (read-only)' : 'Plan (flow:plan, Opus)'}
                </button>
              ))}
            </div>
            <ChatPanel
              {...chat}
              hasProject
              {...(mode === 'plan' ? { placeholder: PLAN_PLACEHOLDER } : {})}
              aboveInput={
                chat.planReady ? (
                  <PlanReadyCard
                    projectId={selected}
                    planFile={chat.planReady.planFile}
                    problem={chat.planReady.problem}
                    onStarted={() => {
                      chat.clearPlanReady()
                      showPipelineTab()
                      setWorkspaceKey((k) => k + 1)
                    }}
                    onDismiss={chat.clearPlanReady}
                  />
                ) : undefined
              }
            />
          </>
        )
      }
    />
  )
}
