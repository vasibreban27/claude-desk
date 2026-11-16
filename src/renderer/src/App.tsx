import { useMemo } from 'react'
import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { Workspace } from './components/Workspace'
import { useProjects } from './hooks/useProjects'
import { useChat } from './hooks/useChat'
import './styles/layout.css'

export function App() {
  const projects = useProjects()
  const chat = useChat(projects.selectedId)
  const projectNames = useMemo(
    () => Object.fromEntries(projects.projects.map((p) => [p.id, p.name])),
    [projects.projects]
  )
  return (
    <Layout
      projects={<ProjectsPanel {...projects} />}
      workspace={
        projects.selectedId !== null ? (
          <Workspace projectId={projects.selectedId} projectNames={projectNames} />
        ) : undefined
      }
      chat={<ChatPanel {...chat} hasProject={projects.selectedId !== null} />}
    />
  )
}
