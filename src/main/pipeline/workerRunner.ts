import { query, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import { logToolUse, type LogSink } from './pipelineLog'
import { effectiveLimits, type ProjectSettings } from '../../shared/settings'
import { guardWorkerToolUse } from './workerGuard'
import { WORK_ALLOWED_TOOLS, WORK_SERVER_NAME, createWorkerTools, type CheckResult } from './workerTools'
import { buildFixPrompt, buildWorkerPrompt, buildWorkerSystemPrompt, type FixInput } from './prompts'
import type { PlanTask } from './planParser'
import { parseResultMessage, type RunUsage } from '../chat/activity'

/**
 * Runs one worker session (Agent SDK `query()`), following docs/notes/phase-4a-spike.md:
 * no `options.agent`, app-built prompt, built-in tools cut to Read/Grep/Glob/Write/Edit, `permissionMode: 'acceptEdits'`,
 * stop by flagging the reason and calling `query.close()` (abort as backup), and catching the error the iterator
 * throws after an error result. The guard in workerGuard.ts is the boundary; `tools` is a second layer.
 */

export const MAX_TURNS = 40
export const TIME_CAP_MS = 20 * 60 * 1000
export const WORKER_BUILTIN_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Write', 'Edit']

export type WorkerStatus = 'finished' | 'limit' | 'cancelled' | 'error'

export interface WorkerOutcome {
  status: WorkerStatus
  /** The (capped) reason the worker gave through `report_blocked`, if any. */
  blocked: string | null
  turns: number | null
  costUsd: number | null
  checksResult: CheckResult
  /** The SDK session id, for resuming in the next fix round. */
  sessionId?: string
  /** Short text for `error`. */
  error?: string
}

export interface WorkerRunArgs {
  task: PlanTask
  worktree: string
  /** The expected `task/<runId8>-<taskId>` branch. */
  branch: string
  settings: ProjectSettings
  pluginPath: string
  signal?: AbortSignal
  /** A fix round: the failing output or findings, and the session to resume (null/absent: fresh session). */
  fix?: FixInput & { sessionId?: string | null }
  /** Live log: one short line per tool call (relative paths, no contents). */
  onLog?: LogSink
  /** Token usage of each session's result message (for the Usage tab). */
  onUsage?: (usage: RunUsage) => void
}

export type WorkerRunner = (args: WorkerRunArgs) => Promise<WorkerOutcome>

/** The part of the SDK `Query` the runner uses. */
export interface QueryLike extends AsyncIterable<unknown> {
  close(): void
}
export type QueryFn = (params: { prompt: string; options: Options }) => QueryLike

export interface WorkerRunnerDeps {
  queryFn?: QueryFn
  timeCapMs?: number
  maxTurns?: number
}

export interface BuiltWorker {
  options: Options
  prompt: string
  getBlocked: () => string | null
  getCheckResult: () => CheckResult
}

/** Builds the SDK options and prompt for one task (pure apart from creating the in-process MCP server). */
export function buildWorkerOptions(
  args: WorkerRunArgs,
  abortController: AbortController,
  maxTurns: number = effectiveLimits(args.settings).maxTurns,
  resumeId: string | null = null
): BuiltWorker {
  let blocked: string | null = null
  const tools = createWorkerTools({
    taskId: args.task.id,
    worktree: args.worktree,
    branch: args.branch,
    owns: args.task.owns,
    checks: args.settings.checks ?? [],
    allowCommands: args.settings.allowCommands === true,
    ...(args.onLog ? { onLog: args.onLog } : {}),
    onBlocked: (reason) => {
      blocked = reason
    }
  })
  const guard: HookCallback = async (input) => {
    const out = guardWorkerToolUse(input, {
      worktree: args.worktree,
      owns: args.task.owns,
      protectedPatterns: args.settings.protectedPaths
    })
    logToolUse(args.onLog, input, out, args.worktree)
    return out
  }
  const options: Options = {
    cwd: args.worktree,
    // Never load project/user settings: a worktree's .claude/settings.json is untrusted (see chat runner).
    settingSources: [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: buildWorkerSystemPrompt(args.task) },
    plugins: [{ type: 'local', path: args.pluginPath }],
    tools: [...WORKER_BUILTIN_TOOLS],
    allowedTools: [...WORKER_BUILTIN_TOOLS, ...WORK_ALLOWED_TOOLS],
    permissionMode: 'acceptEdits',
    maxTurns,
    ...modelOption(args),
    mcpServers: { [WORK_SERVER_NAME]: tools.createServer() },
    hooks: { PreToolUse: [{ hooks: [guard], onFailure: 'block' }] },
    abortController,
    ...(resumeId !== null ? { resume: resumeId } : {})
  }
  // Resume keeps the conversation, so the fix text alone is enough; a fresh session also needs the task.
  const prompt =
    args.fix === undefined
      ? buildWorkerPrompt(args.task)
      : resumeId !== null
        ? buildFixPrompt(args.fix)
        : `${buildWorkerPrompt(args.task)}\n\n${buildFixPrompt(args.fix)}`
  return {
    options,
    prompt,
    getBlocked: () => blocked,
    getCheckResult: tools.getCheckResult
  }
}

const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus']

/** The task Model wins over the project model; `auto` (or an unknown value) means the SDK default. */
function modelOption(args: WorkerRunArgs): { model?: string } {
  const taskModel: unknown = args.task.model
  if (typeof taskModel === 'string' && MODELS.includes(taskModel)) return { model: taskModel }
  const project = args.settings.model
  return project !== 'auto' ? { model: project } : {}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const LIMIT_TEXT = /maximum number of turns/i

export function createWorkerRunner(deps: WorkerRunnerDeps = {}): WorkerRunner {
  const queryFn: QueryFn = deps.queryFn ?? ((p) => query(p))

  /** One session; `resumeId` resumes a previous worker session. */
  const runOnce = async (args: WorkerRunArgs, resumeId: string | null): Promise<WorkerOutcome> => {
    const limits = effectiveLimits(args.settings)
    const timeCap = deps.timeCapMs ?? limits.timeCapMs
    const maxTurns = deps.maxTurns ?? limits.maxTurns
    const abortController = new AbortController()
    let reason: 'cancelled' | 'limit' | null = null
    let q: QueryLike | null = null
    let timer: NodeJS.Timeout | null = null
    let onAbort: (() => void) | null = null
    let sessionId: string | null = null
    const done = (...a: Parameters<typeof outcome>): WorkerOutcome => ({
      ...outcome(...a),
      ...(sessionId !== null ? { sessionId } : {})
    })

    const stop = (why: 'cancelled' | 'limit'): void => {
      if (reason === null) reason = why
      try {
        q?.close()
      } catch {
        // already closed
      }
      abortController.abort()
    }

    let built: BuiltWorker
    try {
      built = buildWorkerOptions(args, abortController, maxTurns, resumeId)
    } catch (e) {
      return done('error', null, null, null, 'none', `could not build the worker: ${errText(e)}`)
    }

    let turns: number | null = null
    let costUsd: number | null = null
    let assistantTurns = 0
    let resultError: string | null = null
    let hitTurnLimit = false
    let thrown: unknown = null

    try {
      if (args.signal?.aborted) return done('cancelled', null, null, null, 'none')
      q = queryFn({ prompt: built.prompt, options: built.options })
      onAbort = () => stop('cancelled')
      args.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => stop('limit'), timeCap)
      try {
        for await (const message of q) {
          if (!isRecord(message)) continue
          if (message['type'] === 'assistant') assistantTurns += 1
          if (typeof message['session_id'] === 'string' && message['session_id'].length > 0) {
            sessionId = message['session_id']
          }
          if (message['type'] === 'result') {
            reportUsage(args.onUsage, message)
            if (typeof message['num_turns'] === 'number') turns = message['num_turns']
            if (typeof message['total_cost_usd'] === 'number') costUsd = message['total_cost_usd']
            if (message['subtype'] === 'error_max_turns') hitTurnLimit = true
            if (message['is_error'] === true) {
              const errors = message['errors']
              resultError = Array.isArray(errors) ? errors.filter((x) => typeof x === 'string').join('; ') : String(message['subtype'])
            }
          }
        }
      } catch (e) {
        // The iterator throws after an error result, after close() and after an abort.
        thrown = e
      }
    } catch (e) {
      thrown = e
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (onAbort !== null) args.signal?.removeEventListener('abort', onAbort)
    }

    const t = turns ?? assistantTurns
    const blocked = built.getBlocked()
    const checks = built.getCheckResult()
    const stopped = reason as 'cancelled' | 'limit' | null
    if (stopped === 'cancelled') return done('cancelled', blocked, t, costUsd, checks)
    if (stopped === 'limit') return done('limit', blocked, t, costUsd, checks)
    if (hitTurnLimit || (thrown !== null && LIMIT_TEXT.test(errText(thrown)))) {
      return done('limit', blocked, t, costUsd, checks)
    }
    if (resultError !== null) return done('error', blocked, t, costUsd, checks, resultError)
    if (thrown !== null) return done('error', blocked, t, costUsd, checks, errText(thrown))
    if (turns === null) return done('error', blocked, t, costUsd, checks, 'session ended without a result')
    return done('finished', blocked, t, costUsd, checks)
  }

  return async (args) => {
    const resumeId = args.fix?.sessionId ?? null
    if (resumeId === null) return runOnce(args, null)
    const resumed = await runOnce(args, resumeId)
    // The resume itself failed (not a limit, a cancel or a worker that ran): start a fresh session with the findings.
    if (resumed.status !== 'error' || args.signal?.aborted === true) return resumed
    const fresh = await runOnce(args, null)
    const cost = resumed.costUsd === null && fresh.costUsd === null ? null : (resumed.costUsd ?? 0) + (fresh.costUsd ?? 0)
    return { ...fresh, costUsd: cost, turns: (resumed.turns ?? 0) + (fresh.turns ?? 0) }
  }
}

function outcome(
  status: WorkerStatus,
  blocked: string | null,
  turns: number | null,
  costUsd: number | null,
  checksResult: CheckResult,
  error?: string
): WorkerOutcome {
  return { status, blocked, turns, costUsd, checksResult, ...(error !== undefined ? { error: error.slice(0, 300) } : {}) }
}

/** Hands the parsed result usage to the sink; a broken sink never breaks the session. */
export function reportUsage(sink: ((usage: RunUsage) => void) | undefined, message: unknown): void {
  if (sink === undefined) return
  try {
    const usage = parseResultMessage(message)
    if (usage !== null) sink(usage)
  } catch {
    // usage tracking is best effort
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
