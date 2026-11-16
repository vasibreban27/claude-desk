import { Layout } from './components/Layout'
import { ProjectsPanel } from './components/Projects'
import { ChatPanel } from './components/Chat'
import { useProjects } from './hooks/useProjects'
import { useChat } from './hooks/useChat'
import './styles/layout.css'

export function App() {
  const projects = useProjects()
  const chat = useChat(projects.selectedId)
  return (
    <Layout
      projects={<ProjectsPanel {...projects} />}
      chat={<ChatPanel {...chat} hasProject={projects.selectedId !== null} />}
    />
  )
}
