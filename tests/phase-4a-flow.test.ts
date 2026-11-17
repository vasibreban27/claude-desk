import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../src/main/db/migrations'
import { createPipelineStore, type PipelineStore } from '../src/main/db/pipelineStore'
import type { SettingsStore } from '../src/main/db/settingsStore'
import { createOrchestrator, type Orchestrator, type RunSummary } from '../src/main/pipeline/orchestrator'
import { guardWorkerToolUse } from '../src/main/pipeline/workerGuard'
import { createWorkerRunner, type WorkerOutcome, type WorkerRunArgs, type QueryLike } from '../src/main/pipeline/workerRunner'
import { createWorkerTools } from '../src/main/pipeline/workerTools'
import { APP_IDENTITY, GIT_ENV_ADDITIONS, GIT_PREFIX } from '../src/main/pipeline/worktrees'
import { defaultSettings } from '../src/shared/settings'

// Real git and real worktrees are slow on Windows: generous limits for this file only.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

const BLANK_FILTER = ['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']

/** Hardened git for the test's own setup and assertions. */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_PREFIX, ...BLANK_FILTER, ...APP_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV_ADDITIONS }
  })
}

const task = (id: string, owns: string, deps: string): string =>
  [
    `### ${id}: title ${id}`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Contract: none',
    `- Owns: \`${owns}\``,
    `- Depends on: ${deps}`,
    '- Acceptance criteria:',
    `  - ${id} works`,
    ''
  ].join('\n')

const plan = (...waves: string[][]): string =>
  ['# Plan: e2e', '', '## 7. Tasks', '', ...waves.flatMap((w, i) => [`### Wave ${i + 1}`, '', ...w])].join('\n')

type Script = (args: WorkerRunArgs, h: Helpers) => Promise<Partial<WorkerOutcome> | void>

interface Helpers {
  /** Write through the real worker guard (Write tool policy); returns false when denied. */
  write: (rel: string, content: string) => boolean
  tools: ReturnType<typeof createWorkerTools>
}

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n')

describe('phase 4a pipeline, end to end (real git, in-memory db, fake workers)', () => {
  let base: string
  let repo: string
  let store: PipelineStore
  let db: Database.Database
  let baseCommit: string

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4a-')))
    repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n')
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
    // The worktree manager links the primary node_modules into each task worktree and refuses to run without one.
    fs.mkdirSync(path.join(repo, 'node_modules'))
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')
    baseCommit = g(repo, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'uncommitted, must survive\n')
    db = new Database(':memory:')
    migrate(db)
    store = createPipelineStore(db)
  })

  afterEach(() => {
    db.close()
    for (const dir of [path.join(base, '.worktrees'), base]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // best effort: a leftover temp folder must not fail the test
      }
    }
  })

  function settings(): SettingsStore {
    return { get: () => ({ settings: defaultSettings(), notice: null }), set: () => ({ ok: false, error: 'invalid' }) }
  }

  /** A runner that behaves like a worker: guarded writes, then the real git_commit tool. */
  function scripted(scripts: Record<string, Script>) {
    const calls: string[] = []
    const runner = async (args: WorkerRunArgs): Promise<WorkerOutcome> => {
      calls.push(args.task.id)
      let blocked: string | null = null
      const tools = createWorkerTools({
        taskId: args.task.id,
        worktree: args.worktree,
        branch: args.branch,
        owns: args.task.owns,
        checks: [],
        onBlocked: (r) => {
          blocked = r
        }
      })
      const write = (rel: string, content: string): boolean => {
        const filePath = path.join(args.worktree, rel)
        const verdict = guardWorkerToolUse(
          { tool_name: 'Write', tool_input: { file_path: filePath, content } },
          { worktree: args.worktree, owns: args.task.owns, protectedPatterns: args.settings.protectedPaths }
        ) as { hookSpecificOutput?: { permissionDecision?: string } }
        if (verdict.hookSpecificOutput?.permissionDecision === 'deny') return false
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, content)
        return true
      }
      const script = scripts[args.task.id]
      const extra = script ? await script(args, { write, tools }) : undefined
      return {
        status: 'finished',
        blocked,
        turns: 2,
        costUsd: 0,
        checksResult: tools.getCheckResult(),
        ...(extra ?? {})
      }
    }
    return { runner, calls }
  }

  /** Writes `files` (guarded) and commits them through the real git_commit tool. */
  const editAndCommit =
    (files: Record<string, string>): Script =>
    async (_args, h) => {
      for (const [rel, content] of Object.entries(files)) {
        if (!h.write(rel, content)) return { blocked: `write to ${rel} denied` }
      }
      const r = await h.tools.handlers.git_commit({ paths: Object.keys(files), message: 'work' })
      if (r.isError === true) throw new Error(`git_commit failed: ${text(r)}`)
    }

  async function start(orch: Orchestrator, planText: string): Promise<{ runId: string; summary: RunSummary }> {
    const planPath = path.join(base, 'plan.md')
    fs.writeFileSync(planPath, planText)
    const r = await orch.startRun({ projectId: 'p', projectPath: repo, planPath, baseBranch: 'main' })
    if (!r.ok) throw new Error(r.error)
    return { runId: r.runId, summary: await r.finished }
  }

  const make = (runner: (a: WorkerRunArgs) => Promise<WorkerOutcome>): Orchestrator =>
    createOrchestrator({ store, settings: settings(), runner, pluginPath: base })

  const run = (runId: string) => {
    const r = store.getRun(runId)
    if (!r.ok) throw new Error('run not found')
    return r.value
  }
  const taskRows = (runId: string) => {
    const r = store.listTasks(runId)
    if (!r.ok) throw new Error('tasks not found')
    return r.value
  }
  const show = (branch: string, file: string): string | null => {
    try {
      return g(repo, 'show', `${branch}:${file}`)
    } catch {
      return null
    }
  }

  it('runs two waves; run/<id> holds all changes; main and the primary checkout are untouched', async () => {
    const { runner, calls } = scripted({
      T1: editAndCommit({ 'a.txt': 'one\n' }),
      T2: editAndCommit({ 'b.txt': 'two\n' }),
      T3: editAndCommit({ 'c.txt': 'three\n' })
    })
    const statusBefore = g(repo, 'status', '--porcelain')
    const mainBefore = g(repo, 'rev-parse', 'main').trim()
    const scratchBefore = fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8')

    const { runId, summary } = await start(
      make(runner),
      plan([task('T1', 'a.txt', 'none'), task('T2', 'b.txt', 'none')], [task('T3', 'c.txt', 'T1, T2')])
    )

    expect(summary.status).toBe('done')
    expect(calls).toEqual(['T1', 'T2', 'T3'])
    expect(taskRows(runId).map((t) => t.status)).toEqual(['done', 'done', 'done'])
    const branch = run(runId).integrationBranch
    expect(branch).toMatch(/^run\//)
    expect([show(branch, 'a.txt'), show(branch, 'b.txt'), show(branch, 'c.txt')]).toEqual(['one\n', 'two\n', 'three\n'])

    expect(g(repo, 'rev-parse', 'main').trim()).toBe(mainBefore)
    expect(g(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8')).toBe(scratchBefore)
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false)
    expect(g(repo, 'branch', '--show-current').trim()).toBe('main')
  })

  it('denies a write outside Owns: the task fails as blocked and its dependents are blocked', async () => {
    const { runner } = scripted({
      T1: async (_a, h) => {
        const denied = !h.write('other.txt', 'x\n')
        expect(denied).toBe(true)
        await h.tools.handlers.report_blocked({ reason: 'need other.txt' })
      },
      T2: editAndCommit({ 'b.txt': 'two\n' })
    })
    const { runId, summary } = await start(
      make(runner),
      plan([task('T1', 'a.txt', 'none')], [task('T2', 'b.txt', 'T1')])
    )
    expect(summary.status).toBe('failed')
    const rows = taskRows(runId)
    expect(rows[0]).toMatchObject({ taskId: 'T1', status: 'failed', reason: 'blocked: need other.txt' })
    expect(rows[1]).toMatchObject({ taskId: 'T2', status: 'blocked' })
    expect(show(run(runId).integrationBranch, 'other.txt')).toBeNull()
    expect(fs.existsSync(path.join(repo, 'other.txt'))).toBe(false)
  })

  it('fails the second task with merge conflict when both change the same line', async () => {
    // Valid plan (Owns may repeat across waves). The stale-branch reset makes T2 diverge from run/<id>.
    const { runner } = scripted({
      T1: editAndCommit({ 'shared.txt': 'from T1\n' }),
      T2: async (args, h) => {
        g(args.worktree, 'reset', '--hard', baseCommit)
        return editAndCommit({ 'shared.txt': 'from T2\n' })(args, h)
      }
    })
    const { runId, summary } = await start(
      make(runner),
      plan([task('T1', 'shared.txt', 'none')], [task('T2', 'shared.txt', 'T1')])
    )
    expect(summary.status).toBe('failed')
    const rows = taskRows(runId)
    expect(rows[0]).toMatchObject({ status: 'done' })
    expect(rows[1]).toMatchObject({ status: 'failed', reason: 'merge conflict' })
    expect(show(run(runId).integrationBranch, 'shared.txt')).toBe('from T1\n')
    // The aborted merge leaves the integration worktree clean.
    expect(g(run(runId).integrationPath, 'status', '--porcelain').trim()).toBe('')
  })

  it('later waves branch from run/<id> even when the base branch moves mid-run', async () => {
    let seenByT2: { a: boolean; moved: boolean } | null = null
    const { runner } = scripted({
      T1: async (args, h) => {
        // The user commits to main in the primary checkout while the run is in progress.
        fs.writeFileSync(path.join(repo, 'moved.txt'), 'moved\n')
        g(repo, 'add', 'moved.txt')
        g(repo, 'commit', '-q', '-m', 'main moves')
        return editAndCommit({ 'a.txt': 'one\n' })(args, h)
      },
      T2: async (args, h) => {
        seenByT2 = {
          a: fs.existsSync(path.join(args.worktree, 'a.txt')),
          moved: fs.existsSync(path.join(args.worktree, 'moved.txt'))
        }
        return editAndCommit({ 'b.txt': 'two\n' })(args, h)
      }
    })
    const { runId, summary } = await start(
      make(runner),
      plan([task('T1', 'a.txt', 'none')], [task('T2', 'b.txt', 'T1')])
    )
    expect(summary.status).toBe('done')
    expect(seenByT2).toEqual({ a: true, moved: false })
    expect(run(runId).baseCommit).toBe(baseCommit)
    expect(g(repo, 'rev-parse', 'main').trim()).not.toBe(baseCommit)
    const branch = run(runId).integrationBranch
    expect(show(branch, 'moved.txt')).toBeNull()
    expect(show(branch, 'b.txt')).toBe('two\n')
  })

  it('F3: a cancel that arrives while the last task is finishing leaves every task done', async () => {
    let orch: Orchestrator | null = null
    let id = ''
    const { runner } = scripted({
      T1: async (args, h) => {
        await editAndCommit({ 'a.txt': 'one\n' })(args, h)
        // Cancel lands after the work is committed, before the orchestrator merges it.
        orch?.cancel(id)
      }
    })
    orch = make(runner)
    const planPath = path.join(base, 'plan.md')
    fs.writeFileSync(planPath, plan([task('T1', 'a.txt', 'none')]))
    const r = await orch.startRun({ projectId: 'p', projectPath: repo, planPath, baseBranch: 'main' })
    if (!r.ok) throw new Error(r.error)
    id = r.runId
    const summary = await r.finished
    // The worker returned `finished` and the task merged, so it is done. Known quirk (plan follow-up F3):
    // the orchestrator forces the run status to `cancelled` once cancel() was called, even though nothing was lost.
    expect(taskRows(r.runId)[0]).toMatchObject({ status: 'done' })
    expect(show(run(r.runId).integrationBranch, 'a.txt')).toBe('one\n')
    expect(['done', 'cancelled']).toContain(summary.status)
  })

  describe('real workerRunner with a scripted SDK stream', () => {
    const fakeQuery =
      (messages: unknown[], thrown?: Error) =>
      (): QueryLike => ({
        close: () => undefined,
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m
          if (thrown) throw thrown
        }
      })

    it('maps the turn limit (result then throw) to "limit reached" and blocks dependents', async () => {
      const runner = createWorkerRunner({
        queryFn: fakeQuery(
          [{ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 41, total_cost_usd: 0.02 }],
          new Error('Claude Code returned an error result: Reached maximum number of turns (40)')
        )
      })
      const { runId, summary } = await start(
        make(runner),
        plan([task('T1', 'a.txt', 'none')], [task('T2', 'b.txt', 'T1')])
      )
      expect(summary.status).toBe('failed')
      const rows = taskRows(runId)
      expect(rows[0]).toMatchObject({ status: 'failed', reason: 'limit reached', turns: 41, costUsd: 0.02 })
      expect(rows[1]).toMatchObject({ status: 'blocked' })
    })

    it('treats a session that ends without a result as a worker error (no commit is never "done")', async () => {
      const runner = createWorkerRunner({ queryFn: fakeQuery([{ type: 'assistant' }]) })
      const { runId, summary } = await start(make(runner), plan([task('T1', 'a.txt', 'none')]))
      expect(summary.status).toBe('failed')
      expect(taskRows(runId)[0]).toMatchObject({ status: 'failed', reason: 'worker error' })
    })

    it('a finished session that committed nothing fails as "no commit"', async () => {
      const runner = createWorkerRunner({
        queryFn: fakeQuery([{ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0 }])
      })
      const { runId } = await start(make(runner), plan([task('T1', 'a.txt', 'none')]))
      expect(taskRows(runId)[0]).toMatchObject({ status: 'failed', reason: 'no commit' })
    })
  })
})
