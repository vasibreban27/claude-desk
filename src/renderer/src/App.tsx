import { useMemo, useState } from 'react'
import { ASSISTANT_PROJECT_ID, type Project } from '@shared/ipc'
import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { ProposalCard } from './components/Chat/ProposalCard'
import { Workspace, WORKSPACE_TAB_KEY } from './components/Workspace'
import { useProjects } from './hooks/useProjects'
import { useChat } from './hooks/useChat'
import './styles/layout.css'

export function App() {
  const projects = useProjects()
  const [assistant, setAssistant] = useState(false)
  const [handOffError, setHandOffError] = useState<string | null>(null)
  const chat = useChat(assistant ? ASSISTANT_PROJECT_ID : projects.selectedId)
  const projectNames = useMemo(
    () => Object.fromEntries(projects.projects.map((p) => [p.id, p.name])),
    [projects.projects]
  )

  async function handOff(project: Project, planFile: string | null) {
    chat.clearProposal()
    setHandOffError(null)
    try {
      localStorage.setItem(WORKSPACE_TAB_KEY, 'pipeline')
    } catch {
      // the tab is a convenience
    }
    projects.adopt(project)
    setAssistant(false)
    if (planFile === null) return
    try {
      const r = await window.api.pipelineStart({ projectId: project.id, planFile })
      if (!r.ok) setHandOffError(`Project created, but the pipeline did not start (${r.error}). Start ${planFile} from the Pipeline tab.`)
    } catch {
      setHandOffError(`Project created, but the pipeline did not start. Start ${planFile} from the Pipeline tab.`)
    }
  }

  const panel = (
    <ProjectsPanel
      {...projects}
      selectedId={assistant ? null : projects.selectedId}
      select={async (id) => {
        setAssistant(false)
        await projects.select(id)
      }}
    />
  )
  return (
    <Layout
      projects={
        <>
          <button type="button" aria-pressed={assistant} onClick={() => setAssistant(true)}>
            Assistant
          </button>
          {panel}
        </>
      }
      workspace={
        !assistant && projects.selectedId !== null ? (
          <Workspace projectId={projects.selectedId} projectNames={projectNames} />
        ) : undefined
      }
      chat={
        <>
          {handOffError && (
            <p role="alert" className="chat__handoff-error">
              {handOffError}
            </p>
          )}
          {assistant && chat.proposal && (
            <ProposalCard
              name={chat.proposal.name}
              brief={chat.proposal.brief}
              worker={chat.proposal.worker}
              onCreated={(p, b) => void handOff(p, b)}
              onCancel={chat.clearProposal}
            />
          )}
          <ChatPanel {...chat} hasProject={assistant || projects.selectedId !== null} />
        </>
      }
    />
  )
}
