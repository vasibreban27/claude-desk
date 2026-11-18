import { useMemo, useState } from 'react'
import { ASSISTANT_PROJECT_ID, type Project } from '@shared/ipc'
import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { ProposalCard } from './components/Chat/ProposalCard'
import { Workspace } from './components/Workspace'
import { useProjects } from './hooks/useProjects'
import { useChat } from './hooks/useChat'
import './styles/layout.css'

export function App() {
  const projects = useProjects()
  const [assistant, setAssistant] = useState(false)
  const chat = useChat(assistant ? ASSISTANT_PROJECT_ID : projects.selectedId)
  const projectNames = useMemo(
    () => Object.fromEntries(projects.projects.map((p) => [p.id, p.name])),
    [projects.projects]
  )

  async function handOff(project: Project, brief: string) {
    chat.clearProposal()
    projects.adopt(project)
    setAssistant(false)
    try {
      await window.api.chatSend({ projectId: project.id, text: brief })
    } catch {
      // the project exists; the user can send the brief by hand
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
          {assistant && chat.proposal && (
            <ProposalCard
              name={chat.proposal.name}
              brief={chat.proposal.brief}
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
