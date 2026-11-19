import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { CheckConfig } from '../../shared/settings'

const TIMEOUT_MS = 120_000
const MAX_PACKAGE_BYTES = 512 * 1024

/** Suggestions only: no command is run or saved until the user adds and saves it. */
export async function suggestChecks(projectPath: string): Promise<CheckConfig[]> {
  const isFile = async (name: string): Promise<boolean> => {
    try {
      const st = await lstat(path.join(projectPath, name))
      return st.isFile() && !st.isSymbolicLink()
    } catch {
      return false
    }
  }
  const out: CheckConfig[] = []
  const add = (name: string, executable: string, args: string[]): void => {
    out.push({ name, executable, args, timeoutMs: TIMEOUT_MS })
  }
  if (await isFile('pom.xml')) add('maven-test', 'mvn', ['-q', 'test'])
  if (await isFile('package.json')) {
    try {
      const file = path.join(projectPath, 'package.json')
      if ((await lstat(file)).size <= MAX_PACKAGE_BYTES) {
        const pkg: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (typeof pkg === 'object' && pkg !== null && 'scripts' in pkg) {
          const scripts = pkg.scripts
          if (typeof scripts === 'object' && scripts !== null && 'test' in scripts && typeof scripts.test === 'string' && scripts.test.trim()) {
            add('npm-test', 'npm', ['test'])
          }
        }
      }
    } catch {
      // An invalid package manifest yields no suggestion.
    }
  }
  if (await isFile('pyproject.toml')) add('python-test', 'python', ['-m', 'pytest'])
  if (await isFile('go.mod')) add('go-test', 'go', ['test', './...'])
  if (await isFile('Cargo.toml')) add('rust-test', 'cargo', ['test'])
  try {
    const files = await readdir(projectPath, { withFileTypes: true })
    if (files.some((f) => f.isFile() && /^[-\w.]+\.sln$/i.test(f.name))) add('dotnet-test', 'dotnet', ['test'])
  } catch {
    // An unreadable project has no further suggestions.
  }
  return out
}
