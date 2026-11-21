import type { CheckConfig } from '@shared/ipc'

/** Common checks to pick from in Settings, grouped by stack. Each runs without a shell, one argument per item. */
export interface CheckPreset {
  group: string
  label: string
  check: CheckConfig
}

const c = (name: string, executable: string, args: string[], timeoutSec: number, acceptsTestPath = false): CheckConfig => ({
  name,
  executable,
  args,
  timeoutMs: timeoutSec * 1000,
  ...(acceptsTestPath ? { acceptsTestPath } : {})
})

export const CHECK_PRESETS: readonly CheckPreset[] = [
  { group: 'Java (Maven)', label: 'Run the tests: mvn -q test', check: c('maven-test', 'mvn', ['-q', 'test'], 300) },
  { group: 'Java (Maven)', label: 'Tests and checks: mvn -q verify', check: c('maven-verify', 'mvn', ['-q', 'verify'], 600) },
  { group: 'Java (Gradle)', label: 'Run the tests: gradle test', check: c('gradle-test', 'gradle', ['test', '--quiet'], 300) },
  { group: 'JavaScript / TypeScript', label: 'Run the tests: npm test', check: c('npm-test', 'npm', ['test'], 300) },
  { group: 'JavaScript / TypeScript', label: 'Type check: npm run typecheck', check: c('typecheck', 'npm', ['run', 'typecheck'], 180) },
  { group: 'JavaScript / TypeScript', label: 'Lint: npm run lint', check: c('lint', 'npm', ['run', 'lint'], 180) },
  { group: 'JavaScript / TypeScript', label: 'Build: npm run build', check: c('build', 'npm', ['run', 'build'], 300) },
  { group: 'Python', label: 'Run the tests: pytest -q', check: c('pytest', 'pytest', ['-q'], 300, true) },
  { group: 'Python', label: 'Lint: ruff check .', check: c('ruff', 'ruff', ['check', '.'], 120) },
  { group: 'Python', label: 'Type check: mypy .', check: c('mypy', 'mypy', ['.'], 180) },
  { group: 'Go', label: 'Run the tests: go test ./...', check: c('go-test', 'go', ['test', './...'], 300) },
  { group: 'Go', label: 'Vet: go vet ./...', check: c('go-vet', 'go', ['vet', './...'], 120) },
  { group: 'Rust', label: 'Run the tests: cargo test', check: c('cargo-test', 'cargo', ['test', '--quiet'], 600) },
  { group: 'Rust', label: 'Lint: cargo clippy', check: c('cargo-clippy', 'cargo', ['clippy', '--quiet'], 300) },
  { group: '.NET', label: 'Run the tests: dotnet test', check: c('dotnet-test', 'dotnet', ['test', '--nologo'], 600) }
]

/** The command line a check runs, for display. */
export const commandOf = (check: CheckConfig): string => [check.executable, ...check.args].join(' ')

/** Groups in their listed order. */
export function presetGroups(): { group: string; presets: CheckPreset[] }[] {
  const out: { group: string; presets: CheckPreset[] }[] = []
  for (const p of CHECK_PRESETS) {
    const g = out.find((x) => x.group === p.group)
    if (g) g.presets.push(p)
    else out.push({ group: p.group, presets: [p] })
  }
  return out
}
