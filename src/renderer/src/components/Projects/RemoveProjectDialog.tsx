import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/ipc'

export interface RemoveProjectDialogProps {
  project: Project
  onRemove: (deleteFolder: boolean) => Promise<string | null>
  onClose: () => void
}

/** Confirms removing a project; deleting the folder is an explicit, separate opt-in (moved to the Recycle Bin). */
export function RemoveProjectDialog({ project, onRemove, onClose }: RemoveProjectDialogProps) {
  const [deleteFolder, setDeleteFolder] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  async function confirm() {
    setWorking(true)
    setError(null)
    const err = await onRemove(deleteFolder && !project.missing)
    setWorking(false)
    if (err === null) onClose()
    else setError(err)
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="remove-project-title"
      className="projects__confirm"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !working) onClose()
      }}
    >
      <h3 id="remove-project-title">Remove {project.name}?</h3>
      {project.missing ? (
        <p>The folder no longer exists. The project is removed from Odyssey.</p>
      ) : (
        <>
          <p>The project is removed from Odyssey. Its folder stays on disk unless you tick the box.</p>
          <label className="projects__confirm-check">
            <input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} disabled={working} />{' '}
            Also move the folder to the Recycle Bin
          </label>
          {deleteFolder && (
            <p className="projects__confirm-path" title={project.path}>
              <code>{project.path}</code> and everything in it, including uncommitted work and the git history.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="projects__error">
          {error}
        </p>
      )}
      <div className="projects__confirm-actions">
        <button type="button" ref={cancelRef} onClick={onClose} disabled={working}>
          Cancel
        </button>
        <button type="button" className="projects__danger" onClick={() => void confirm()} disabled={working}>
          {working ? 'Removing...' : deleteFolder && !project.missing ? 'Remove and delete folder' : 'Remove'}
        </button>
      </div>
    </div>
  )
}
