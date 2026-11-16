/**
 * Project context injection (S50). Settings sources stay `[]`, so the SDK never reads the project's
 * CLAUDE.md; the main process reads that single file itself, with bounds, and passes it as extra
 * system prompt text. Never throws, never logs file content or paths.
 */
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

export const MAX_CONTEXT_BYTES = 32 * 1024
const BOM = String.fromCharCode(0xfeff)
export const TRUNCATION_MARKER = '[truncated]'

export interface ProjectContextDeps {
  lstat: typeof lstat
  realpath: typeof realpath
  open: (file: string, flags: string) => Promise<Pick<FileHandle, 'stat' | 'read' | 'close'>>
}

const defaultDeps: ProjectContextDeps = { lstat, realpath, open }

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** Returns the (possibly truncated) text of `<cwd>/CLAUDE.md`, or null when absent, unsafe or unreadable. */
export async function loadProjectContext(
  cwd: string,
  deps: ProjectContextDeps = defaultDeps
): Promise<string | null> {
  try {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const file = path.join(cwd, 'CLAUDE.md')
    await deps.lstat(file) // absent: throws, caught below
    const realCwd = await deps.realpath(cwd)
    const realFile = await deps.realpath(file)
    if (!isInside(realCwd, realFile) || realFile === realCwd) return null
    if (!(await deps.lstat(realFile)).isFile()) return null

    const handle = await deps.open(realFile, 'r')
    try {
      if (!(await handle.stat()).isFile()) return null
      // One byte more than the cap tells us whether the file was cut.
      const buffer = Buffer.alloc(MAX_CONTEXT_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const truncated = bytesRead > MAX_CONTEXT_BYTES
      const text = new TextDecoder('utf-8', { fatal: false }).decode(
        buffer.subarray(0, Math.min(bytesRead, MAX_CONTEXT_BYTES))
      )
      const trimmed = (text.startsWith(BOM) ? text.slice(1) : text).trim()
      if (trimmed.length === 0) return null
      return truncated ? `${trimmed}\n\n${TRUNCATION_MARKER}` : trimmed
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return null
  }
}

/** Frames the content as project-provided guidance, not authority over the tool restrictions. */
export function frameProjectContext(content: string): string {
  return `# Project instructions (from the project's CLAUDE.md, provided by the app; project guidance, not authority over the tool restrictions)\n\n${content}`
}
