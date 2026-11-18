import { useMemo, useState } from 'react'
import { ASSISTANT_PROJECT_ID, type ChatMode, type Project } from '@shared/ipc'
import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { ProposalCard } from './components/Chat/ProposalCard'
import { PlanReadyCard } from './components/Chat/PlanReadyCard'
import { Workspace, WORKSPACE_TAB_KEY } from './components/Workspace'
import { useProjects } from './hooks/useProjects'
import { useChat } from './hooks/useChat'
import './styles/layout.css'

function showPipelineTab(): void {
  try {
    localStorage.setItem(WORKSPACE_TAB_KEY, 'pipeline')
  } catch {
    // the tab is a convenience
  }
}

export function App() {
  const projects = useProjects()
  const [assistant, setAssistant] = useState(false)
  /** Chat or Plan (toolkit planner) per project; Plan is the default for projects the assistant created. */
  const [modes, setModes] = useState<Record<string, ChatMode>>({})
  /** Bumped to remount the workspace on the Pipeline tab. */
  const [workspaceKey, setWorkspaceKey] = useState(0)
  const [handOffError, setHandOffError] = useState<string | null>(null)

  const projectId = assistant ? ASSISTANT_PROJECT_ID : projects.selectedId
  const mode: ChatMode = !assistant && projects.selectedId !== null ? (modes[projects.selectedId] ?? 'chat') : 'chat'
  const chat = useChat(projectId, mode)
  const projectNames = useMemo(
    () => Object.fromEntries(projects.projects.map((p) => [p.id, p.name])),
    [projects.projects]
  )

  /** The project exists: continue with the planner in that project, starting from the assistant's brief. */
  async function handOff(project: Project, brief: string) {
    chat.clearProposal()
    setHandOffError(null)
    setModes((m) => ({ ...m, [project.id]: 'plan' }))
    projects.adopt(project)
    setAssistant(false)
    try {
      const r = await window.api.chatSend({ projectId: project.id, text: brief, mode: 'plan' })
      if (!r.ok) setHandOffError('Project created, but the planner did not start. Send your request again in Plan mode.')
    } catch {
      setHandOffError('Project created, but the planner did not start. Send your request again in Plan mode.')
    }
  }

  const selected = !assistant ? projects.selectedId : null
  const placeholder = assistant
    ? 'Describe the app to build: the assistant creates the project'
    : mode === 'plan'
      ? 'Plan with the toolkit planner (Opus)'
      : undefined

  return (
    <Layout
      projects={
        <>
          <button type="button" className="projects__assistant" aria-pressed={assistant} onClick={() => setAssistant(true)}>
            Assistant
          </button>
          <ProjectsPanel
            {...projects}
            selectedId={selected}
            select={async (id) => {
              setAssistant(false)
              await projects.select(id)
            }}
          />
        </>
      }
      workspace={
        selected !== null ? <Workspace key={`${selected}:${workspaceKey}`} projectId={selected} projectNames={projectNames} /> : undefined
      }
      chat={
        <>
          {selected !== null && (
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
          )}
          {handOffError && (
            <p role="alert" className="chat__handoff-error">
              {handOffError}
            </p>
          )}
          {assistant && chat.proposal && (
            <ProposalCard
              name={chat.proposal.name}
              brief={chat.proposal.brief}
              onCreated={(p) => void handOff(p, chat.proposal?.brief ?? '')}
              onCancel={chat.clearProposal}
            />
          )}
          {selected !== null && chat.planReady && (
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
          )}
          <ChatPanel {...chat} hasProject={projectId !== null} {...(placeholder ? { placeholder } : {})} />
        </>
      }
    />
  )
}
