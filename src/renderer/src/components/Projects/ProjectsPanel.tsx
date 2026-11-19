import type { UseProjects } from '../../hooks/useProjects'
import { useState } from 'react'
import type { Project } from '@shared/ipc'
import { ThemeToggle } from '../ThemeToggle'
import { RemoveProjectDialog } from './RemoveProjectDialog'
import './projects.css'

export interface ProjectsPanelProps extends UseProjects {
  /** Switches the chat to "describe a new project"; without it Add project only opens a folder. */
  onNewProject?: () => void
}

export function ProjectsPanel({
  projects,
  selectedId,
  loading,
  loadError,
  addError,
  adding,
  add,
  select,
  remove,
  onNewProject
}: ProjectsPanelProps) {
  const [removing, setRemoving] = useState<Project | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="projects">
      <div className="projects__body">
        <div className="projects__add-wrap">
          <button
            type="button"
            className="projects__add"
            onClick={() => (onNewProject ? setMenuOpen((o) => !o) : void add())}
            disabled={adding}
            {...(onNewProject ? { 'aria-expanded': menuOpen, 'aria-controls': 'projects-add-menu' } : {})}
          >
            Add project
          </button>
          {onNewProject && menuOpen && (
            <div id="projects-add-menu" className="projects__add-menu" role="group" aria-label="Add project">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onNewProject()
                }}
              >
                New project
                <span>Describe it in the chat</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void add()
                }}
              >
                Existing folder…
                <span>Open a git repository</span>
              </button>
            </div>
          )}
        </div>
        {addError && (
          <p role="alert" className="projects__error">
            {addError}
          </p>
        )}
        {loading && <p className="projects__status">Loading projects…</p>}
        {loadError && (
          <p role="alert" className="projects__error">
            {loadError}
          </p>
        )}
        {!loading && !loadError && projects.length === 0 && (
          <div className="projects__empty">
            <p className="projects__empty-title">No projects yet. Create one or add a git folder to start.</p>
            <p className="projects__empty-hint">Projects you add appear here with their branch and status.</p>
          </div>
        )}
        <ul className="projects__list">
          {projects.map((p) => {
            const branch = p.branch ?? 'detached'
            return (
              <li key={p.id} className="projects__row">
                <button
                  type="button"
                  className="projects__item"
                  aria-pressed={p.id === selectedId}
                  onClick={() => void select(p.id)}
                >
                  <span className="projects__name" title={p.name}>
                    {p.name}
                  </span>
                  <span className="projects__meta">
                    <span className="projects__branch" title={branch}>
                      {branch}
                    </span>
                    {p.missing ? (
                      <span className="badge badge--dirty">missing</span>
                    ) : (
                      <span className={p.dirty ? 'badge badge--dirty' : 'badge badge--clean'}>
                        {p.dirty ? 'dirty' : 'clean'}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="projects__remove"
                  aria-label={`Remove ${p.name}`}
                  title="Remove project"
                  onClick={() => setRemoving(p)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      {removing && (
        <RemoveProjectDialog project={removing} onRemove={(del) => remove(removing.id, del)} onClose={() => setRemoving(null)} />
      )}
      <footer className="projects__footer">
        <ThemeToggle />
      </footer>
    </div>
  )
}
