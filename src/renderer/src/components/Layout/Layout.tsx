import type { ReactNode } from 'react'

export interface LayoutProps {
  projects: ReactNode
  workspace?: ReactNode
  chat: ReactNode
}

export const WORKSPACE_PLACEHOLDER = 'Runs, activity and usage will appear here'

export function Layout({ projects, workspace, chat }: LayoutProps) {
  return (
    <div className="layout">
      <aside className="layout__panel" aria-labelledby="panel-projects-title">
        <h2 id="panel-projects-title" className="layout__title">
          Projects
        </h2>
        {projects}
      </aside>
      <main className="layout__panel" aria-labelledby="panel-workspace-title">
        <h2 id="panel-workspace-title" className="layout__title">
          Workspace
        </h2>
        {workspace ?? <p className="layout__placeholder">{WORKSPACE_PLACEHOLDER}</p>}
      </main>
      <section className="layout__panel" aria-labelledby="panel-chat-title">
        <h2 id="panel-chat-title" className="layout__title">
          Chat
        </h2>
        {chat}
      </section>
    </div>
  )
}
