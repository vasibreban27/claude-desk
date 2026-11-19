/**
 * What counts as "uncommitted work" before the checks gate. Generated files (bytecode and tool caches, virtualenvs,
 * installed packages, build output, local databases) are ignored: tests create them, they are never part of the task
 * and the merge only takes commits. Everything else that is modified or untracked is reported by path.
 */
const ARTIFACT_DIRS = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', '.eggs',
  'node_modules', '.next', '.nuxt', '.turbo', '.vite', '.cache', 'coverage', '.nyc_output', 'htmlcov',
  'dist', 'build', 'out', 'target', 'bin', 'obj', '.gradle', '.idea', '.vscode'
])
const ARTIFACT_FILE = /(\.py[cod]|\.egg-info|\.log|\.tsbuildinfo|\.db|\.sqlite3?|\.db-journal|\.coverage|\.DS_Store|Thumbs\.db)$/i

export const MAX_REPORTED_PATHS = 20

export function isArtifact(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  if (parts.slice(0, -1).some((p) => ARTIFACT_DIRS.has(p))) return true
  const last = parts[parts.length - 1] ?? ''
  return ARTIFACT_DIRS.has(last) || ARTIFACT_FILE.test(last) || /\.egg-info$/.test(last)
}

/** Parses `git status --porcelain=v1 -z` output into the paths that are real uncommitted work. */
export function uncommittedWork(porcelainZ: string): string[] {
  const out: string[] = []
  const entries = porcelainZ.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? ''
    if (e.length < 4) continue
    const status = e.slice(0, 2)
    const file = e.slice(3)
    // A rename or copy is followed by its source path as a separate entry.
    if (status[0] === 'R' || status[0] === 'C') i++
    if (!isArtifact(file)) out.push(file)
  }
  return out
}
