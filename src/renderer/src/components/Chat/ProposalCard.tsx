import { useEffect, useState } from 'react'
import type { Project, ProjectsCreateResult } from '@shared/ipc'

const ERRORS: Record<string, string> = {
  'invalid-name': 'That project name is not allowed.',
  'no-root': 'Choose a projects folder first.',
  exists: 'A folder with that name already exists.',
  escape: 'The folder would be outside the projects folder.',
  'git-failed': 'Could not initialise git.',
  'register-failed': 'Could not register the project.'
}

export interface ProposalCardProps {
  name: string
  brief: string
  worker: string | null
  onCreated: (project: Project, planFile: string | null) => void
  onCancel: () => void
}

/** Confirmation for an assistant-proposed project. Only the click creates anything. */
export function ProposalCard({ name, brief, worker, onCreated, onCancel }: ProposalCardProps) {
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    window.api.projectsRootGet().then((r) => setRoot(r.root), () => setRoot(null))
  }, [])

  async function pickRoot() {
    try {
      setRoot((await window.api.projectsRootPick()).root)
    } catch {
      setError('Could not set the projects folder.')
    }
  }

  async function confirm() {
    setWorking(true)
    setError(null)
    try {
      const r: ProjectsCreateResult = await window.api.createProject({ name, brief, ...(worker ? { worker } : {}) })
      if (r.ok) onCreated(r.project, r.planFile)
      else setError(ERRORS[r.error] ?? 'Could not create the project.')
    } catch {
      setError('Could not create the project.')
    } finally {
      setWorking(false)
    }
  }

  const sep = root !== null && root.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/'
  return (
    <div className="chat__proposal" role="group" aria-label="Create project">
      <p>
        Create project <strong>{name}</strong>
      </p>
      <p>{root === null ? 'No projects folder set.' : `Folder: ${root}${sep}${name}`}</p>
      <p>
        A git repository is created on main, the brief is saved as docs/plans/bootstrap.md and a pipeline run starts
        {worker ? ` (${worker})` : ''}. Its workers may run allow-listed commands such as npm install in this project.
      </p>
      <blockquote>{brief}</blockquote>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void pickRoot()}>
        {root === null ? 'Choose projects folder' : 'Change folder'}
      </button>{' '}
      <button type="button" onClick={() => void confirm()} disabled={working || root === null}>
        Create project
      </button>{' '}
      <button type="button" onClick={onCancel} disabled={working}>
        Cancel
      </button>
    </div>
  )
}
