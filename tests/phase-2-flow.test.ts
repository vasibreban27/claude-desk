import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityDraft, AgentUsage, RunUsage } from '../src/main/chat/activity'
import { buildHooks, type ChatRunner, type RunnerItem } from '../src/main/chat/runner'
import { ChatService } from '../src/main/chat/service'
import { createRunStore, openDatabase } from '../src/main/db'
import { createHandlers } from '../src/main/ipc/handlers'
import type { ProjectStore } from '../src/main/projects/store'
import type { ActivityEvent, ChatEvent } from '../src/shared/ipc'

type HookFn = (input: unknown, id: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>
type HookMap = Record<string, Array<{ hooks: unknown[] }>>

const base = { session_id: 's', transcript_path: '' }
const LEAK_MARKER = 'tool-response-body-must-not-leak'

function makeFire(cwd: string, drafts: ActivityDraft[]) {
  const hooks = buildHooks((d) => drafts.push(d), cwd) as unknown as HookMap
  return async (input: Record<string, unknown>): Promise<unknown> => {
    let out: unknown = {}
    for (const m of hooks[String(input['hook_event_name'])] ?? []) {
      for (const cb of m.hooks) {
        out = await (cb as HookFn)({ ...base, cwd, ...input }, undefined, { signal: new AbortController().signal })
      }
    }
    return out
  }
}

describe('phase 2 flow (SDK mocked, real hooks, service, SQLite file and handlers)', () => {
  let root: string
  let db: Database.Database

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'desk-p2-')))
    db = openDatabase(join(root, 'data', 'claude-desk.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it(
    'streams activity in order and reports usage for main and a subagent',
    async () => {
      const projectId = '11111111-1111-4111-8111-111111111111'
      const events: ChatEvent[] = []
      const live: ActivityEvent[] = []
      let finish: () => void = () => {}
      const finished = new Promise<void>((r) => (finish = r))

      const usage: RunUsage = {
        costUsd: 0.0123,
        durationMs: 1500,
        isError: false,
        models: [
          {
            model: 'claude-haiku',
            costUsd: 0.0123,
            inputTokens: 300,
            outputTokens: 120,
            cacheReadTokens: 50,
            cacheCreationTokens: 10
          }
        ],
        mainTokens: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 30, cacheCreationTokens: 5 }
      }
      const agents: AgentUsage[] = [
        { agent: 'main', steps: 2, ...usage.mainTokens, approximate: false },
        {
          agent: 'Explore',
          steps: 1,
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheCreationTokens: 5,
          approximate: true
        }
      ]

      // Fake runner: fires the real hook callbacks (guard and trackers) like the SDK would.
      // Guard outcomes are captured here and asserted in the test body.
      const outcomes: { denied?: unknown; outside?: unknown; inside?: unknown } = {}
      const runner: ChatRunner = (args) => fakeRun(args.cwd, outcomes, usage, agents)
      const fakeRun = async function* (
        cwd: string,
        out: { denied?: unknown; outside?: unknown; inside?: unknown },
        usage: RunUsage,
        agents: AgentUsage[]
      ): AsyncGenerator<RunnerItem> {
        const drafts: ActivityDraft[] = []
        const fire = makeFire(cwd, drafts)
        const flush = function* (): Generator<RunnerItem> {
          while (drafts.length) yield { kind: 'activity', draft: drafts.shift() as ActivityDraft }
        }

        yield { kind: 'session', sessionId: 'sess-1' }
        yield { kind: 'text', text: 'Looking' }

        await fire({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a.txt' } })
        await fire({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', duration_ms: 12, tool_input: {}, tool_response: LEAK_MARKER })
        yield* flush()

        const sub = { agent_id: 'ag1', agent_type: 'Explore' }
        await fire({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_input: { pattern: 'foo' }, ...sub })
        await fire({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't2', duration_ms: 7, tool_input: {}, ...sub })
        await fire({ hook_event_name: 'SubagentStop', last_assistant_message: 'found it', ...sub })
        yield* flush()

        out.denied = await fire({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't3', tool_input: { file_path: 'x' } })
        out.outside = await fire({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't4', tool_input: { file_path: join(cwd, '..', 'elsewhere.txt') } })
        out.inside = await fire({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't5', tool_input: { file_path: join(cwd, 'ok.txt') } })
        yield* flush()

        yield { kind: 'usage', usage, agents }
      }

      const store = createRunStore(db)
      const chat = new ChatService({
        resolveProjectPath: (id) => (id === projectId ? root : undefined),
        runner,
        emit: (e) => {
          events.push(e)
          if (e.type === 'done' || e.type === 'error') finish()
        },
        emitActivity: (e) => live.push(e),
        runStore: store,
        loadConfig: () => ({ ok: true, config: { toolkitPath: '/toolkit' } })
      })
      const h = createHandlers({
        store: {} as ProjectStore,
        readGitStatus: async () => {
          throw new Error('unused')
        },
        pickFolder: async () => undefined,
        chat,
        runStore: store
      })

      expect((await h.chatSend({ projectId, text: 'go' })).ok).toBe(true)
      await finished
      expect(events.at(-1)?.type).toBe('done')

      const history = await h.activityHistory({ projectId })
      expect(history).toEqual(live)
      expect(history.map((e) => e.seq)).toEqual(history.map((_, i) => i))
      expect(new Set(history.map((e) => e.runId)).size).toBe(1)
      const shape = history.map((e) => {
        const t = e as Record<string, unknown>
        return [e.type, e.agent, t['tool'] ?? ''].join('|')
      })
      expect(shape).toEqual([
        'run-started|main|',
        'tool-started|main|Read',
        'tool-finished|main|Read',
        'tool-started|Explore|Grep',
        'tool-finished|Explore|Grep',
        'agent-finished|Explore|',
        'tool-started|main|Write',
        'tool-finished|main|Write',
        'tool-started|main|Read',
        'tool-finished|main|Read',
        'tool-started|main|Read',
        'run-finished|main|'
      ])
      expect(history[1]).toMatchObject({ summary: 'a.txt' })
      expect(history[2]).toMatchObject({ durationMs: 12, denied: false })
      expect(history[5]).toMatchObject({ summary: 'found it', agentId: 'ag1' })
      expect(history[7]).toMatchObject({ denied: true, durationMs: null })
      expect(history[9]).toMatchObject({ type: 'tool-finished', denied: true, toolUseId: 't4' })
      expect(history[11]).toMatchObject({ status: 'success', costUsd: 0.0123 })
      expect(JSON.stringify(outcomes.denied)).toContain('deny')
      expect(JSON.stringify(outcomes.outside)).toContain('deny')
      expect(outcomes.inside).toEqual({})
      expect(JSON.stringify(history)).not.toContain(LEAK_MARKER)

      const summary = await h.usageSummary({ projectId, days: 7 })
      expect(summary.estimated).toBe(true)
      expect(summary.totals).toMatchObject({ runs: 1, costUsd: 0.0123 })
      expect(summary.byAgent.map((a) => a.agent).sort()).toEqual(['Explore', 'main'])
      expect(summary.byAgent.find((a) => a.agent === 'main')).toMatchObject({ approximate: false, outputTokens: 80 })
      expect(summary.byAgent.find((a) => a.agent === 'Explore')).toMatchObject({ approximate: true, outputTokens: 40 })
      expect(summary.byDay).toHaveLength(1)
      expect(summary.byProject).toEqual([])

      const all = await h.usageSummary({ projectId: null, days: 7 })
      expect(all.byProject).toMatchObject([{ projectId, runs: 1 }])

      expect(await h.activityHistory({ projectId: 'bad' })).toEqual([])
      expect((await h.usageSummary({ days: 0 })).totals.runs).toBe(0)
    },
    20000
  )

  it('records an error run with usage when the result is an error', async () => {
    const projectId = '22222222-2222-4222-8222-222222222222'
    let finish: () => void = () => {}
    const finished = new Promise<void>((r) => (finish = r))
    const usage: RunUsage = {
      costUsd: 0.5,
      durationMs: 10,
      isError: true,
      models: [],
      mainTokens: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }
    }
    const agents: AgentUsage[] = [{ agent: 'main', steps: 1, ...usage.mainTokens, approximate: false }]
    const runner: ChatRunner = async function* () {
      yield { kind: 'usage', usage, agents }
      throw new Error('sdk-result-error')
    }
    const store = createRunStore(db)
    const live: ActivityEvent[] = []
    const chat = new ChatService({
      resolveProjectPath: (id) => (id === projectId ? root : undefined),
      runner,
      emit: (e) => {
        if (e.type === 'done' || e.type === 'error') finish()
      },
      emitActivity: (e) => live.push(e),
      runStore: store,
      loadConfig: () => ({ ok: true, config: { toolkitPath: '/toolkit' } })
    })
    expect(chat.send(projectId, 'go').ok).toBe(true)
    await finished
    expect(live.at(-1)).toMatchObject({ type: 'run-finished', status: 'error' })
    const summary = store.summary({ projectId, days: 7 })
    expect(summary.totals).toMatchObject({ runs: 1, costUsd: 0.5 })
  })
})
