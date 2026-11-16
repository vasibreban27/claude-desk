import type { ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import '../../styles/layout.css'

export interface LayoutProps {
  projects: ReactNode
  workspace?: ReactNode
  chat: ReactNode
}

export const WORKSPACE_PLACEHOLDER = 'Runs, activity and usage will appear here'
export const LAYOUT_STORAGE_KEY = 'claude-desk:layout'

const PANEL_IDS = ['projects', 'workspace', 'chat'] as const
const DEFAULT_LAYOUT: Record<string, number> = { projects: 20, workspace: 45, chat: 35 }

export function readStoredLayout(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT
    const layout: Record<string, number> = {}
    for (const id of PANEL_IDS) {
      const value = (parsed as Record<string, unknown>)[id]
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100) {
        return DEFAULT_LAYOUT
      }
      layout[id] = value
    }
    const sum = PANEL_IDS.reduce((acc, id) => acc + (layout[id] ?? 0), 0)
    return Math.abs(sum - 100) < 1 ? layout : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

function storeLayout(layout: Record<string, number>): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // storage unavailable: sizes simply are not remembered
  }
}

export function Layout({ projects, workspace, chat }: LayoutProps) {
  return (
    <Group
      className="layout"
      orientation="horizontal"
      defaultLayout={readStoredLayout()}
      onLayoutChanged={storeLayout}
    >
      <Panel id="projects" minSize="180px" className="layout__cell">
        <aside className="layout__panel" aria-labelledby="panel-projects-title">
          <h2 id="panel-projects-title" className="layout__title">
            Projects
          </h2>
          <div className="layout__body">{projects}</div>
        </aside>
      </Panel>
      <Separator className="layout__separator" />
      <Panel id="workspace" minSize="280px" className="layout__cell">
        <main className="layout__panel" aria-labelledby="panel-workspace-title">
          <h2 id="panel-workspace-title" className="layout__title">
            Workspace
          </h2>
          <div className="layout__body">
            {workspace ?? (
              <div className="layout__empty">
                <p className="layout__empty-title">Nothing running yet</p>
                <p className="layout__empty-hint">{WORKSPACE_PLACEHOLDER}</p>
              </div>
            )}
          </div>
        </main>
      </Panel>
      <Separator className="layout__separator" />
      <Panel id="chat" minSize="320px" className="layout__cell">
        <section className="layout__panel" aria-labelledby="panel-chat-title">
          <h2 id="panel-chat-title" className="layout__title">
            Chat
          </h2>
          <div className="layout__body">{chat}</div>
        </section>
      </Panel>
    </Group>
  )
}
