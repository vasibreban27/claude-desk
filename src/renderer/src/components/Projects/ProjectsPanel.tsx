import type { UseProjects } from '../../hooks/useProjects'
import { ThemeToggle } from '../ThemeToggle'
import './projects.css'

export function ProjectsPanel({ projects, selectedId, loading, loadError, addError, adding, add, select }: UseProjects) {
  return (
    <div className="projects">
      <div className="projects__body">
        <button type="button" className="projects__add" onClick={() => void add()} disabled={adding}>
          Add project
        </button>
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
            <p className="projects__empty-title">No projects yet. Add a git folder to start.</p>
            <p className="projects__empty-hint">Projects you add appear here with their branch and status.</p>
          </div>
        )}
        <ul className="projects__list">
          {projects.map((p) => {
            const branch = p.branch ?? 'detached'
            return (
              <li key={p.id}>
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
                    <span className={p.dirty ? 'badge badge--dirty' : 'badge badge--clean'}>
                      {p.dirty ? 'dirty' : 'clean'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <footer className="projects__footer">
        <ThemeToggle />
      </footer>
    </div>
  )
}
