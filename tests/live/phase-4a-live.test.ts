import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { createPipelineStore } from '../../src/main/db/pipelineStore'
import { createSettingsStore } from '../../src/main/db/settingsStore'
import { createOrchestrator } from '../../src/main/pipeline/orchestrator'
import { createWorkerRunner } from '../../src/main/pipeline/workerRunner'
import { APP_IDENTITY, GIT_ENV_ADDITIONS, GIT_PREFIX } from '../../src/main/pipeline/worktrees'
import { defaultSettings } from '../../src/shared/settings'

/**
 * Live pipeline check: real Agent SDK sessions, real cost, needs the owner's Claude login.
 * Runs ONLY with CLAUDE_DESK_LIVE=1 (and CLAUDE_TOOLKIT_PATH pointing at the `flow` plugin folder);
 * otherwise vitest reports the test as skipped. See docs/notes/phase-4a-manual-check.md.
 */
const LIVE = process.env['CLAUDE_DESK_LIVE'] === '1'
const suite = describe.skipIf(!LIVE)

const BLANK = ['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_PREFIX, ...BLANK, ...APP_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV_ADDITIONS }
  })
}

const PLAN = `# Plan: live check

## 7. Tasks

### Wave 1

### T1: Add one.txt
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: \`src/one.txt\`
- Depends on: none
- Acceptance criteria:
  - \`src/one.txt\` exists and contains the single line \`one\`
  - the check \`verify\` passes (run it with run_check)

### Wave 2

### T2: Add two.txt
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: \`src/two.txt\`
- Depends on: T1
- Acceptance criteria:
  - \`src/two.txt\` exists and contains the single line \`two\`
  - \`src/one.txt\` (from T1) is visible in your worktree
  - the check \`verify\` passes (run it with run_check)
`

const CHECK_SCRIPT = `import { readdirSync, readFileSync } from 'node:fs'
const files = readdirSync('src').filter((f) => f.endsWith('.txt'))
for (const f of files) {
  if (readFileSync('src/' + f, 'utf8').trim() === '') { console.error('empty: ' + f); process.exit(1) }
}
console.log('ok: ' + files.length + ' file(s)')
`

suite('phase 4a live run (CLAUDE_DESK_LIVE=1)', () => {
  it(
    'runs two dependent tasks with real SDK sessions and merges both into run/<id>',
    async () => {
      const toolkit = process.env['CLAUDE_TOOLKIT_PATH']
      if (!toolkit) throw new Error('CLAUDE_TOOLKIT_PATH must point at the flow plugin folder')

      const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4a-live-')))
      const repo = path.join(base, 'repo')
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
      g(repo, 'init', '-q', '-b', 'main')
      fs.writeFileSync(path.join(repo, 'check.mjs'), CHECK_SCRIPT)
      fs.writeFileSync(path.join(repo, 'src', '.gitkeep'), '')
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
      fs.mkdirSync(path.join(repo, 'node_modules'))
      const planPath = path.join(base, 'plan.md')
      fs.writeFileSync(planPath, PLAN)
      g(repo, 'add', '.')
      g(repo, 'commit', '-q', '-m', 'init')

      const db = new Database(':memory:')
      migrate(db)
      const store = createPipelineStore(db)
      const settings = createSettingsStore(db)
      // Checks are seeded through SettingsStore, never read from the repo.
      const saved = settings.set('live', {
        ...defaultSettings(),
        model: 'haiku',
        checks: [{ name: 'verify', executable: 'node', args: ['check.mjs'], timeoutMs: 60_000 }]
      })
      expect(saved.ok).toBe(true)

      const orch = createOrchestrator({
        store,
        settings,
        runner: createWorkerRunner(),
        pluginPath: toolkit,
        log: (m) => console.log(m)
      })
      const started = await orch.startRun({ projectId: 'live', projectPath: repo, planPath, baseBranch: 'main' })
      if (!started.ok) throw new Error(started.error)
      const summary = await started.finished

      const tasks = store.listTasks(started.runId)
      const run = store.getRun(started.runId)
      if (!tasks.ok || !run.ok) throw new Error('store read failed')
      let total = 0
      console.log('task | status | duration ms | turns | cost USD | checks')
      for (const t of tasks.value) {
        total += t.costUsd ?? 0
        console.log(`${t.taskId} | ${t.status}${t.reason ? ` (${t.reason})` : ''} | ${t.durationMs} | ${t.turns} | ${t.costUsd} | ${t.checksResult}`)
      }
      console.log(`total cost USD: ${total}; kept for inspection: ${base}`)

      expect(summary.status).toBe('done')
      const branch = run.value.integrationBranch
      expect(g(repo, 'show', `${branch}:src/one.txt`).trim()).toBe('one')
      expect(g(repo, 'show', `${branch}:src/two.txt`).trim()).toBe('two')
      expect(g(repo, 'rev-parse', 'main').trim()).toBe(run.value.baseCommit)
      db.close()
    },
    35 * 60 * 1000
  )
})
