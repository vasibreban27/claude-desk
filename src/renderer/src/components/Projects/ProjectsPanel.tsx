import type { UseProjects } from '../../hooks/useProjects'

export function ProjectsPanel({ projects, selectedId, loading, loadError, addError, adding, add, select }: UseProjects) {
  return (
    <div className="projects">
      <button type="button" onClick={() => void add()} disabled={adding}>
        Add project
      </button>
      {addError && (
        <p role="alert" className="projects__error">
          {addError}
        </p>
      )}
      {loading && <p>Loading projects…</p>}
      {loadError && (
        <p role="alert" className="projects__error">
          {loadError}
        </p>
      )}
      {!loading && !loadError && projects.length === 0 && <p>No projects yet. Add a git folder to start.</p>}
      <ul className="projects__list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="projects__item"
              aria-pressed={p.id === selectedId}
              onClick={() => void select(p.id)}
            >
              <span className="projects__name">{p.name}</span>
              <span className="projects__meta">
                <span>{p.branch ?? 'detached'}</span>
                <span className={p.dirty ? 'badge badge--dirty' : 'badge badge--clean'}>
                  {p.dirty ? 'dirty' : 'clean'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
