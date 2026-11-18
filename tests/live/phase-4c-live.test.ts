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
 * Live timing check for Phase 4c: the same 3-task wave with maxParallel 1 and 3, real SDK sessions, real cost.
 * Runs ONLY with CLAUDE_DESK_LIVE=1 (and CLAUDE_TOOLKIT_PATH pointing at the `flow` plugin folder);
 * otherwise vitest reports the test as skipped. See docs/notes/phase-4c-timing.md.
 * Run with `--silent=false` to see the printed table.
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

const WORDS: Record<string, string> = { T1: 'one', T2: 'two', T3: 'three' }

// Every task carries `Model: haiku`; the project model is set to opus, so a low cost shows the task model won.
const task = (id: string): string =>
  [
    `### ${id}: Add ${WORDS[id]}.txt`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Size: S',
    '- Sensitive: no',
    '- Contract: none',
    '- Model: haiku',
    `- Owns: \`src/${WORDS[id]}.txt\``,
    '- Read first: `check.mjs`',
    '- Depends on: none',
    '- Done when: `node check.mjs`',
    '- Acceptance criteria:',
    `  - \`src/${WORDS[id]}.txt\` exists and contains the single line \`${WORDS[id]}\``,
    '  - the check `verify` passes (run it with run_check)',
    ''
  ].join('\n')

const PLAN = ['Format: flow-plan/1', '', '# Phase: live parallel check', '', '## Wave 1: independent', '', task('T1'), task('T2'), task('T3')].join('\n')

const CHECK_SCRIPT = `import { readdirSync, readFileSync } from 'node:fs'
const files = readdirSync('src').filter((f) => f.endsWith('.txt'))
for (const f of files) {
  if (readFileSync('src/' + f, 'utf8').trim() === '') { console.error('empty: ' + f); process.exit(1) }
}
console.log('ok: ' + files.length + ' file(s)')
`

interface Measured {
  limit: number
  wallMs: number
  totalCost: number
  rows: string[]
}

async function runOnce(toolkit: string, limit: number): Promise<Measured> {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `p4c-live-${limit}-`)))
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
  try {
    migrate(db)
    const store = createPipelineStore(db)
    const settings = createSettingsStore(db)
    const saved = settings.set('live', {
      ...defaultSettings(),
      model: 'opus',
      maxParallel: limit,
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
    const t0 = Date.now()
    const started = await orch.startRun({ projectId: 'live', projectPath: repo, planPath, baseBranch: 'main' })
    if (!started.ok) throw new Error(started.error)
    const summary = await started.finished
    const wallMs = Date.now() - t0

    const tasks = store.listTasks(started.runId)
    const run = store.getRun(started.runId)
    if (!tasks.ok || !run.ok) throw new Error('store read failed')
    let totalCost = 0
    const rows: string[] = []
    for (const t of tasks.value) {
      totalCost += t.costUsd ?? 0
      rows.push(`${t.taskId} | ${t.status}${t.reason ? ` (${t.reason})` : ''} | ${t.durationMs} | ${t.turns} | ${t.costUsd} | ${t.checksResult}`)
    }

    expect(summary.status).toBe('done')
    for (const t of tasks.value) expect(t.status).toBe('done')
    const branch = run.value.integrationBranch
    for (const id of ['T1', 'T2', 'T3']) {
      const word = WORDS[id] ?? ''
      expect(g(repo, 'show', `${branch}:src/${word}.txt`).trim()).toBe(word)
    }
    expect(g(repo, 'rev-parse', 'main').trim()).toBe(run.value.baseCommit)
    console.log(`kept for inspection: ${base}`)
    return { limit, wallMs, totalCost, rows }
  } finally {
    db.close()
  }
}

suite('phase 4c live timing (CLAUDE_DESK_LIVE=1)', () => {
  it(
    'runs the same 3-task wave with maxParallel 1 and 3 and prints the timing table',
    async () => {
      const toolkit = process.env['CLAUDE_TOOLKIT_PATH']
      if (!toolkit) throw new Error('CLAUDE_TOOLKIT_PATH must point at the flow plugin folder')

      const serial = await runOnce(toolkit, 1)
      const parallel = await runOnce(toolkit, 3)

      for (const m of [serial, parallel]) {
        console.log(`maxParallel ${m.limit}`)
        console.log('task | status | duration ms | turns | cost USD | checks')
        for (const r of m.rows) console.log(r)
        console.log(`total | wall ${m.wallMs} ms | cost USD ${m.totalCost}`)
      }
      console.log(`speedup (wall): ${(serial.wallMs / parallel.wallMs).toFixed(2)}x; cost ratio: ${(parallel.totalCost / serial.totalCost).toFixed(2)}x`)
    },
    60 * 60 * 1000
  )
})
