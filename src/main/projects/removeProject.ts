import { lstat, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ProjectsRemoveResult } from '../../shared/ipc'
import type { ProjectStore } from './store'

export interface RemoveProjectDeps {
  store: Pick<ProjectStore, 'get' | 'remove'>
  /** Moves a folder to the OS Recycle Bin / Trash (Electron `shell.trashItem`). Never a permanent delete. */
  trash: (folder: string) => Promise<void>
  /** True while a pipeline run of the project is active. */
  isBusy?: (projectId: string) => Promise<boolean>
  /** Best effort before deleting the folder: remove the project's pipeline worktrees and branches. */
  cleanupRuns?: (projectId: string) => Promise<void>
  /** Folders that must never be deleted (app data, the projects root, ...). */
  protectedFolders?: string[]
}

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** Why a folder must not be deleted, or null. Refuses roots, the home folder and its parents, and protected folders. */
export async function unsafeToDelete(folder: string, protectedFolders: string[] = []): Promise<string | null> {
  let real: string
  try {
    const st = await lstat(folder)
    if (st.isSymbolicLink()) return 'the project path is a link'
    if (!st.isDirectory()) return 'the project path is not a folder'
    real = await realpath(folder)
  } catch {
    return 'the folder does not exist'
  }
  if (path.parse(real).root === real || path.dirname(real) === real) return 'it is a drive or filesystem root'
  const home = path.resolve(os.homedir())
  const rel = path.relative(real, home)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return 'it is your home folder or contains it'
  for (const p of protectedFolders) {
    let target = path.resolve(p)
    try {
      target = await realpath(p)
    } catch {
      // keep the resolved path
    }
    const r = path.relative(real, target)
    if (fold(real) === fold(target) || (!r.startsWith('..') && !path.isAbsolute(r))) return 'it contains app data or the projects folder'
  }
  return null
}

/**
 * Unregisters a project, and on request moves its folder to the Recycle Bin / Trash first.
 * The folder is only touched when it still exists, passes `unsafeToDelete`, and no pipeline run is active.
 */
export async function removeProject(id: string, deleteFolder: boolean, deps: RemoveProjectDeps): Promise<ProjectsRemoveResult> {
  const project = await deps.store.get(id)
  if (project === undefined) return { ok: false, error: 'not-found' }
  let folderDeleted = false
  if (deleteFolder) {
    const exists = await stat(project.path).then(
      (s) => s.isDirectory(),
      () => false
    )
    if (exists) {
      if (deps.isBusy && (await deps.isBusy(id))) return { ok: false, error: 'busy', message: 'A pipeline run is active: cancel it first.' }
      const unsafe = await unsafeToDelete(project.path, deps.protectedFolders)
      if (unsafe !== null) return { ok: false, error: 'unsafe-path', message: `Not deleting ${project.path}: ${unsafe}.` }
      await deps.cleanupRuns?.(id).catch(() => undefined)
      try {
        await deps.trash(project.path)
        folderDeleted = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error'
        return { ok: false, error: 'trash-failed', message: `Could not move the folder to the Recycle Bin: ${msg}`.slice(0, 300) }
      }
    }
  }
  if (!(await deps.store.remove(id))) return { ok: false, error: 'not-found' }
  return { ok: true, folderDeleted }
}
