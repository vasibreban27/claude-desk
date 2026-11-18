import { PLAN_WORKERS } from '../pipeline/planParser'

export const BOOTSTRAP_PLAN_FILE = 'bootstrap.md'

/** Top-level paths a scaffold usually creates; the worker may only commit files under these. */
export const BOOTSTRAP_OWNS: readonly string[] = [
  'src/', 'app/', 'lib/', 'tests/', 'test/', 'public/', 'static/', 'templates/', 'scripts/', 'config/', 'docs/api/',
  'README.md', '.gitignore', '.editorconfig', '.env.example',
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'index.html',
  'eslint.config.js', '.prettierrc',
  'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'uv.lock',
  'go.mod', 'go.sum', 'main.go', 'Cargo.toml', 'Cargo.lock', 'pom.xml', 'build.gradle', 'settings.gradle',
  'Dockerfile', '.dockerignore', 'Makefile'
]

export const BOOTSTRAP_WORKER_DEFAULT = 'node-developer'

export function bootstrapWorker(worker: string | undefined): string {
  return worker !== undefined && PLAN_WORKERS.includes(worker) ? worker : BOOTSTRAP_WORKER_DEFAULT
}

/** One-wave, one-task plan in the format `parsePlan` accepts. The brief is quoted, single-line per bullet. */
export function bootstrapPlan(name: string, brief: string, worker: string): string {
  const lines = brief
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/`/g, "'").trim())
    .filter((l) => l.length > 0)
    .slice(0, 40)
  return [
    `# Plan: ${name} bootstrap`,
    '',
    '## Brief',
    '',
    ...lines.map((l) => `> ${l}`),
    '',
    '## 7. Tasks',
    '',
    '### Wave 1',
    '',
    `### T1: Scaffold ${name} from the brief`,
    '- Status: [ ] todo',
    `- Worker: ${worker}`,
    '- Contract: none',
    `- Owns: ${BOOTSTRAP_OWNS.map((p) => `\`${p}\``).join(', ')}`,
    '- Depends on: none',
    '- Acceptance criteria:',
    '  - The project builds what the Brief section asks for, kept small.',
    '  - Dependencies are installed with run_command and recorded in the manifest; node_modules and virtualenvs are not committed (.gitignore).',
    '  - A README explains how to run it, and every changed file is committed with git_commit.',
    ''
  ].join('\n')
}
