import { query, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import {
  createUsageAccumulator,
  mapDeniedToolUse,
  mapHookInput,
  parseResultMessage,
  type ActivityDraft,
  type AgentUsage,
  type RunUsage
} from './activity'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROTECTED_PATHS, defaultSettings, type ProjectSettings } from '../../shared/settings'
import { GIT_ALLOWED_TOOLS, GIT_SERVER_NAME, createGitMcpServer } from './gitTools'
import { createProtectedMatcher } from './protectedPaths'
import { frameProjectContext, loadProjectContext } from './projectContext'
import { assistantOptions } from './assistant'
import { ALLOWED_TOOLS, guardPreToolUse, isDenied, type ToolPolicy } from './tools'

/** What the chat service needs from the SDK; the renderer never sees raw SDK objects. */
export type RunnerItem =
  | { kind: 'text'; text: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'activity'; draft: ActivityDraft }
  | { kind: 'usage'; usage: RunUsage; agents: AgentUsage[] }
  | { kind: 'proposal'; name: string; brief: string; worker: string | null }

export interface RunnerArgs {
  prompt: string
  cwd: string
  pluginPath: string
  resume?: string | undefined
  /** The project's settings for this turn, read once by the service; absent means the safe defaults. */
  settings?: ProjectSettings
  signal?: AbortSignal
  /** Workspace assistant: no plugins, no built-in tools, only the proposal tool. */
  assistant?: boolean
}

/** The per-turn guard policy derived from the settings. */
export function policyFromSettings(settings: ProjectSettings): ToolPolicy {
  return {
    protectedPatterns: settings.protectedPaths,
    allowGitRead: settings.allowGitRead,
    allowPlanWrites: settings.allowPlanWrites
  }
}

/**
 * `isProtected` for the git tools: takes a project-relative forward-slash path, joins it onto the real
 * project root and asks the matcher (default patterns when the list is unusable). Fails closed: when the
 * real root cannot be resolved every path counts as protected.
 */
export function createGitIsProtected(
  cwd: string,
  patterns: readonly string[],
  resolveRoot: (p: string) => string = (p) => realpathSync.native(p)
): (relativePath: string) => boolean {
  let realRoot: string
  try {
    realRoot = resolveRoot(cwd)
  } catch {
    return () => true
  }
  let matcher = createProtectedMatcher(patterns, { realRoot })
  if (!matcher.usable) matcher = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot })
  return (relativePath) => matcher.isProtected(path.join(realRoot, ...relativePath.split('/')))
}

export type ChatRunner = (args: RunnerArgs) => AsyncIterable<RunnerItem>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Extracts a text delta from an SDK message, validating its shape at the boundary. */
export function extractTextDelta(message: unknown): string | null {
  if (!isRecord(message) || message['type'] !== 'stream_event') return null
  const event = message['event']
  if (!isRecord(event) || event['type'] !== 'content_block_delta') return null
  const delta = event['delta']
  if (!isRecord(delta) || delta['type'] !== 'text_delta') return null
  const text = delta['text']
  return typeof text === 'string' ? text : null
}

export function extractSessionId(message: unknown): string | null {
  if (!isRecord(message)) return null
  const id = message['session_id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

type Hooks = NonNullable<Options['hooks']>

/**
 * Hooks for one run. The single PreToolUse matcher is the guard (`onFailure: "block"`, fails closed):
 * it first reports `tool-started` (try/catch, never throws), then decides, and reports a denied
 * `tool-finished` itself because a denied tool never reaches PostToolUse. Doing both in one callback
 * keeps start before finish. Tracking-only hooks use `onFailure: "continue"`.
 */
export function buildHooks(emit: (draft: ActivityDraft) => void, cwd: string, policy?: ToolPolicy): Hooks {
  const safeEmit = (draft: ActivityDraft | null): void => {
    if (!draft) return
    try {
      emit(draft)
    } catch {
      // Tracking must never break the run.
    }
  }

  const guard: HookCallback = async (input) => {
    safeEmit(mapHookInput(input))
    const output = guardPreToolUse(input, cwd, policy)
    if (isDenied(output)) safeEmit(mapDeniedToolUse(input))
    return output
  }

  const track: HookCallback = async (input) => {
    safeEmit(mapHookInput(input))
    return {}
  }

  return {
    PreToolUse: [{ hooks: [guard], onFailure: 'block' }],
    PostToolUse: [{ hooks: [track], onFailure: 'continue' }],
    PostToolUseFailure: [{ hooks: [track], onFailure: 'continue' }],
    SubagentStop: [{ hooks: [track], onFailure: 'continue' }]
  }
}

/**
 * Minimal push queue: hook callbacks and the message pump feed one async iterable.
 * The queue is unbounded by design: items are small and one run is short-lived; the consumer
 * (the chat service) drains it as fast as the SDK produces.
 */
function createQueue<T>() {
  const items: T[] = []
  let closed = false
  let failure: { error: unknown } | null = null
  let wake: (() => void) | null = null
  const notify = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push(item: T): void {
      if (closed) return
      items.push(item)
      notify()
    },
    close(error?: { error: unknown }): void {
      if (closed) return
      closed = true
      failure = error ?? null
      notify()
    },
    async *iterate(): AsyncGenerator<T> {
      for (;;) {
        const next = items.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (closed) {
          if (failure) throw failure.error
          return
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
  }
}

export interface SdkRunnerDeps {
  loadProjectContext: (cwd: string) => Promise<string | null>
}

/**
 * Real runner: Agent SDK `query()` using the existing Claude Code login. The project's CLAUDE.md is read
 * by the main process (settingSources stays []) and appended to Claude Code's default system prompt only
 * when it exists; the full `claude_code` preset is used either way.
 */
export function createSdkRunner(deps: SdkRunnerDeps = { loadProjectContext }): ChatRunner {
  return (args) => runSdk(args, deps)
}

export const sdkRunner: ChatRunner = createSdkRunner()

async function* runSdk(args: RunnerArgs, deps: SdkRunnerDeps): AsyncGenerator<RunnerItem> {
  const context = await deps.loadProjectContext(args.cwd).catch(() => null)
  const abortController = new AbortController()
  if (args.signal?.aborted) abortController.abort()
  else args.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  const queue = createQueue<RunnerItem>()
  const settings = args.settings ?? defaultSettings()
  const policy = policyFromSettings(settings)
  const allowedTools: string[] = [...ALLOWED_TOOLS]
  if (settings.allowPlanWrites) allowedTools.push('Write')
  if (settings.allowGitRead) allowedTools.push(...GIT_ALLOWED_TOOLS)
  const stream = query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      // Deliberately []: project, user and local settings are never loaded. A cloned untrusted repo's
      // .claude/settings.json could run command hooks, apiKeyHelper, env and skill shell injections as the
      // user with no trust prompt and outside our PreToolUse guard (S50). The toolkit comes from `plugins`.
      // Revisiting this is a Phase 3/6 decision that needs a per-project trust setting.
      settingSources: [],
      // Always the full Claude Code prompt, so a project with a CLAUDE.md and one without behave alike;
      // the project's CLAUDE.md is only appended when it exists.
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        ...(context ? { append: frameProjectContext(context) } : {})
      },
      plugins: args.assistant ? [] : [{ type: 'local', path: args.pluginPath }],
      includePartialMessages: true,
      allowedTools,
      ...(settings.model !== 'auto' ? { model: settings.model } : {}),
      ...(settings.allowGitRead
        ? {
            mcpServers: {
              [GIT_SERVER_NAME]: createGitMcpServer({
                cwd: args.cwd,
                isProtected: createGitIsProtected(args.cwd, settings.protectedPaths)
              })
            }
          }
        : {}),
      hooks: buildHooks((draft) => queue.push({ kind: 'activity', draft }), args.cwd, policy),
      ...(args.assistant ? assistantOptions((p) => queue.push({ kind: 'proposal', ...p })) : {}),
      abortController,
      ...(args.resume ? { resume: args.resume } : {})
    }
  })

  const accumulator = createUsageAccumulator()
  const pump = (async (): Promise<void> => {
    try {
      let sessionSent = false
      for await (const message of stream) {
        if (!sessionSent) {
          const sessionId = extractSessionId(message)
          if (sessionId) {
            sessionSent = true
            queue.push({ kind: 'session', sessionId })
          }
        }
        const text = extractTextDelta(message)
        if (text !== null) queue.push({ kind: 'text', text })
        accumulator.add(message)
        const usage = parseResultMessage(message)
        if (usage) {
          queue.push({ kind: 'usage', usage, agents: accumulator.agents(usage.mainTokens) })
          if (usage.isError) throw new Error('sdk-result-error')
        }
      }
      queue.close()
    } catch (error) {
      queue.close({ error })
    }
  })()

  try {
    yield* queue.iterate()
  } finally {
    abortController.abort()
    void pump
  }
}
