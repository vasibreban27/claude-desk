import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROTECTED_PATHS, defaultSettings, type ProjectSettings } from '../../shared/settings'
import type { ActivityDraft } from './activity'
import { GIT_ALLOWED_TOOLS, GIT_SERVER_NAME } from './gitTools'
import { ALLOWED_TOOLS, guardPreToolUse } from './tools'

type Hooks = NonNullable<Options['hooks']>
interface Captured {
  options: Options
}

const state = vi.hoisted(() => ({
  captured: null as null | { options: unknown },
  script: (async function* () {}) as (options: unknown) => AsyncGenerator<unknown>
}))

interface GitDeps {
  cwd: string
  isProtected: (p: string) => boolean
}
const gitState = vi.hoisted(() => ({ deps: null as null | GitDeps }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options: unknown }) => {
    state.captured = params
    return state.script(params.options)
  }
}))

vi.mock('./gitTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitTools')>()
  return {
    ...actual,
    createGitMcpServer: (deps: unknown) => {
      gitState.deps = deps as GitDeps
      return { type: 'sdk', name: 'git', marker: 'fake-git-server' }
    }
  }
})

import { buildHooks, buildPrompt, createGitIsProtected, createSdkRunner, policyFromSettings, sdkRunner, type RunnerItem } from './runner'

const run = (args: Partial<Parameters<typeof sdkRunner>[0]> = {}) =>
  sdkRunner({ prompt: 'p', cwd: '/w', pluginPath: '/plug', ...args })

async function collect(it: AsyncIterable<RunnerItem>): Promise<RunnerItem[]> {
  const out: RunnerItem[] = []
  for await (const i of it) out.push(i)
  return out
}

const call = async (hooks: Hooks, event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'SubagentStop', input: unknown) => {
  const matcher = hooks[event]?.[0]
  if (!matcher) throw new Error('no matcher')
  const cb = matcher.hooks[0]
  if (!cb) throw new Error('no callback')
  return cb(input as never, undefined, { signal: new AbortController().signal })
}

const resultMsg = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  session_id: 's1',
  is_error: false,
  total_cost_usd: 0.02,
  duration_ms: 500,
  usage: { input_tokens: 3, output_tokens: 4 },
  modelUsage: {},
  ...extra
})

beforeEach(() => {
  state.captured = null
  gitState.deps = null
})

describe('sdkRunner options', () => {
  it('registers the guard with onFailure block, tracking with continue, and keeps existing options', async () => {
    state.script = async function* () {}
    const ctrl = new AbortController()
    await collect(run({ resume: 'sess', signal: ctrl.signal }))
    const { options } = state.captured as unknown as Captured
    expect(options.allowedTools).toEqual([...ALLOWED_TOOLS])
    expect(options.cwd).toBe('/w')
    expect(options.plugins).toEqual([{ type: 'local', path: '/plug' }])
    expect(options.includePartialMessages).toBe(true)
    expect(options.resume).toBe('sess')
    expect(options.abortController).toBeInstanceOf(AbortController)
    expect(options.hooks?.PreToolUse?.[0]?.onFailure).toBe('block')
    expect(options.hooks?.PostToolUse?.[0]?.onFailure).toBe('continue')
    expect(options.hooks?.SubagentStop?.[0]?.onFailure).toBe('continue')
    expect(options.hooks?.PostToolUseFailure?.[0]?.onFailure).toBe('continue')
    expect(options.settingSources).toEqual([])
  })

  it('passes the framed project CLAUDE.md as an appended claude_code preset only when it exists', async () => {
    state.script = async function* () {}
    const withCtx = createSdkRunner({ loadProjectContext: async () => 'Run npm test.' })
    await collect(withCtx({ prompt: 'p', cwd: '/w', pluginPath: '/plug' }))
    const a = (state.captured as unknown as Captured).options
    expect(a.settingSources).toEqual([])
    expect(a.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
    const append = (a.systemPrompt as { append: string }).append
    expect(append).toContain("Project instructions (from the project's CLAUDE.md")
    expect(append.endsWith('Run npm test.')).toBe(true)

    // Without a CLAUDE.md (or when loading fails) the same full preset is used, with nothing appended.
    const without = createSdkRunner({ loadProjectContext: async () => null })
    await collect(without({ prompt: 'p', cwd: '/w', pluginPath: '/plug' }))
    expect((state.captured as unknown as Captured).options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code'
    })

    const failing = createSdkRunner({ loadProjectContext: async () => Promise.reject(new Error('x')) })
    await collect(failing({ prompt: 'p', cwd: '/w', pluginPath: '/plug' }))
    expect((state.captured as unknown as Captured).options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code'
    })
  })

  it('aborts immediately when the caller signal is already aborted', async () => {
    state.script = async function* () {}
    const ctrl = new AbortController()
    ctrl.abort()
    await collect(run({ signal: ctrl.signal }))
    const { options } = state.captured as unknown as Captured
    expect(options.abortController?.signal.aborted).toBe(true)
  })

  it('aborts the SDK when the caller signal aborts', async () => {
    state.script = async function* () {}
    const ctrl = new AbortController()
    await collect(run({ signal: ctrl.signal }))
    const { options } = state.captured as unknown as Captured
    ctrl.abort()
    expect(options.abortController?.signal.aborted).toBe(true)
  })
})

describe('sdkRunner per-turn settings', () => {
  const opts = () => (state.captured as unknown as Captured).options
  const withSettings = (over: Partial<ProjectSettings>) => ({ ...defaultSettings(), ...over })

  it.each(['haiku', 'sonnet', 'opus'] as const)('passes model alias %s', async (model) => {
    await collect(run({ settings: withSettings({ model }) }))
    expect(opts().model).toBe(model)
  })

  it('has no model key for auto, and equals the Phase 2 options with both toggles off', async () => {
    await collect(run({ settings: defaultSettings() }))
    expect('model' in opts()).toBe(false)
    expect('mcpServers' in opts()).toBe(false)
    expect(opts().allowedTools).toEqual([...ALLOWED_TOOLS])
    const withoutSettings = opts()
    await collect(run())
    expect(Object.keys(opts()).sort()).toEqual(Object.keys(withoutSettings).sort())
    expect(opts().allowedTools).toEqual([...ALLOWED_TOOLS])
  })

  it('allowPlanWrites adds exactly Write and Edit (plan files only) and no MCP server', async () => {
    await collect(run({ settings: withSettings({ allowPlanWrites: true }) }))
    expect(opts().allowedTools).toEqual([...ALLOWED_TOOLS, 'Write', 'Edit'])
    expect('mcpServers' in opts()).toBe(false)
    expect(gitState.deps).toBeNull()
  })

  it('allowGitRead adds exactly the git server and its three tool names', async () => {
    await collect(run({ settings: withSettings({ allowGitRead: true }) }))
    expect(opts().allowedTools).toEqual([...ALLOWED_TOOLS, ...GIT_ALLOWED_TOOLS])
    expect(GIT_ALLOWED_TOOLS).toHaveLength(3)
    expect(Object.keys(opts().mcpServers ?? {})).toEqual([GIT_SERVER_NAME])
    expect(gitState.deps?.cwd).toBe('/w')
  })

  it('both toggles add both capabilities and nothing else', async () => {
    await collect(run({ settings: withSettings({ allowGitRead: true, allowPlanWrites: true }) }))
    expect(opts().allowedTools).toEqual([...ALLOWED_TOOLS, 'Write', 'Edit', ...GIT_ALLOWED_TOOLS])
  })
})

describe('per-turn policy in the hooks', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'runner-policy-')))
    writeFileSync(join(dir, '.env'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'secret.dat'), 'x')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = (file_path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: { file_path } })

  it('denies a protected path in the run it was configured for, using the configured patterns', async () => {
    await collect(
      sdkRunner({ prompt: 'p', cwd: dir, pluginPath: '/plug', settings: { ...defaultSettings(), protectedPaths: ['*.dat'] } })
    )
    const hooks = (state.captured as unknown as Captured).options.hooks as Hooks
    expect(await call(hooks, 'PreToolUse', read('secret.dat'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(isDeniedOutput(await call(hooks, 'PreToolUse', read('.env')))).toBe(false)
  })

  it('denies .env with the default patterns', async () => {
    await collect(sdkRunner({ prompt: 'p', cwd: dir, pluginPath: '/plug', settings: defaultSettings() }))
    const hooks = (state.captured as unknown as Captured).options.hooks as Hooks
    expect(await call(hooks, 'PreToolUse', read('.env'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(isDeniedOutput(await call(hooks, 'PreToolUse', read('notes.txt')))).toBe(false)
  })

  it('allows the exact Write absolute form only when allowPlanWrites is on, and returns the guard output unchanged', async () => {
    const policy = { protectedPatterns: [...DEFAULT_PROTECTED_PATHS], allowGitRead: false, allowPlanWrites: true }
    const target = join(dir, 'docs', 'plans', 'x.md')
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'u', tool_input: { file_path: target, content: 'c' } }
    const on = await call(buildHooks(() => {}, dir, policy), 'PreToolUse', input)
    expect(on).toEqual(guardPreToolUse(input, dir, policy))
    expect(isDeniedOutput(on)).toBe(false)
    const off = await call(buildHooks(() => {}, dir, { ...policy, allowPlanWrites: false }), 'PreToolUse', input)
    expect(isDeniedOutput(off)).toBe(true)
  })

  it('keeps emitting the denied tool-finished through isDenied', async () => {
    const list: ActivityDraft[] = []
    const hooks = buildHooks((d) => list.push(d), dir, policyFromSettings(defaultSettings()))
    await call(hooks, 'PreToolUse', read('.env'))
    expect(list.map((d) => d.type)).toEqual(['tool-started', 'tool-finished'])
    expect(list[1]).toMatchObject({ denied: true })
  })
})

function isDeniedOutput(o: unknown): boolean {
  return (o as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny'
}

describe('createGitIsProtected', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'runner-git-')))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('joins the relative forward-slash path onto the real root and uses the matcher', () => {
    const isProtected = createGitIsProtected(dir, DEFAULT_PROTECTED_PATHS)
    expect(isProtected('.env')).toBe(true)
    expect(isProtected('sub/.env')).toBe(true)
    expect(isProtected('.env.example')).toBe(false)
    expect(isProtected('src/a.ts')).toBe(false)
    expect(isProtected('../x.ts')).toBe(true) // outside the root fails closed
  })

  it('uses the configured patterns, and the defaults when the list is unusable', () => {
    expect(createGitIsProtected(dir, ['*.dat'])('a.dat')).toBe(true)
    expect(createGitIsProtected(dir, ['*.dat'])('.env')).toBe(false)
    const bad = createGitIsProtected(dir, ['x'.repeat(201)])
    expect(bad('.env')).toBe(true)
    expect(bad('src/a.ts')).toBe(false)
  })

  it('fails closed (everything protected) when the real root cannot be resolved', () => {
    const isProtected = createGitIsProtected('/does/not/exist-anywhere', DEFAULT_PROTECTED_PATHS)
    expect(isProtected('src/a.ts')).toBe(true)
    const thrown = createGitIsProtected(dir, DEFAULT_PROTECTED_PATHS, () => {
      throw new Error('EIO')
    })
    expect(thrown('src/a.ts')).toBe(true)
  })

  it('is the adapter handed to the git server', async () => {
    await collect(sdkRunner({ prompt: 'p', cwd: dir, pluginPath: '/plug', settings: { ...defaultSettings(), allowGitRead: true } }))
    expect(gitState.deps?.isProtected('.env')).toBe(true)
    expect(gitState.deps?.isProtected('src/a.ts')).toBe(false)
  })
})

describe('sdkRunner stream', () => {
  it('yields session, activity (from hooks), text and one usage in order', async () => {
    state.script = async function* (options) {
      const hooks = (options as Options).hooks as Hooks
      yield { type: 'system', session_id: 's1' }
      await call(hooks, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_use_id: 'u1',
        tool_input: { file_path: 'a.ts' }
      })
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }
      yield resultMsg()
    }
    const items = await collect(run())
    expect(items.map((i) => i.kind)).toEqual(['session', 'activity', 'text', 'usage'])
    expect(items[1]).toMatchObject({ draft: { type: 'tool-started', tool: 'Read', summary: 'a.ts', agent: 'main' } })
    expect(items[3]).toMatchObject({ usage: { costUsd: 0.02, isError: false }, agents: [{ agent: 'main' }] })
  })

  it('yields usage before throwing when the result is an error', async () => {
    state.script = async function* () {
      yield resultMsg({ is_error: true })
    }
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const i of run()) seen.push(i.kind)
      })()
    ).rejects.toThrow('sdk-result-error')
    expect(seen).toEqual(['session', 'usage'])
  })

  it('propagates a stream failure', async () => {
    state.script = async function* () {
      yield { type: 'system', session_id: 's' }
      throw new Error('network')
    }
    await expect(collect(run())).rejects.toThrow('network')
  })
})

describe('buildHooks', () => {
  const drafts = () => {
    const list: ActivityDraft[] = []
    return { list, hooks: buildHooks((d) => list.push(d), '/w') }
  }

  it('guard allows Read and reports tool-started only', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: { file_path: 'a.ts' } })
    expect(out).toEqual({})
    expect(list.map((d) => d.type)).toEqual(['tool-started'])
  })

  it('guard denies a Read outside the run cwd and allows one inside', async () => {
    const { hooks } = drafts()
    const mk = (file_path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: { file_path } })
    expect(await call(hooks, 'PreToolUse', mk('../outside.txt'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call(hooks, 'PreToolUse', mk('inside.txt'))).toEqual({})
  })

  it('PostToolUseFailure maps to tool-finished with no error content', async () => {
    const { list, hooks } = drafts()
    await call(hooks, 'PostToolUseFailure', { hook_event_name: 'PostToolUseFailure', tool_name: 'Grep', tool_use_id: 'u', error: 'ERR-BODY' })
    expect(list).toEqual([
      { agent: 'main', agentId: null, type: 'tool-finished', toolUseId: 'u', tool: 'Grep', durationMs: null, denied: false }
    ])
  })

  it('guard denies Write, reporting tool-started then a denied tool-finished', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_use_id: 'u',
      tool_input: { file_path: 'x', content: 'SECRET' }
    })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(list.map((d) => d.type)).toEqual(['tool-started', 'tool-finished'])
    expect(list[1]).toMatchObject({ denied: true, tool: 'Write' })
  })

  it('guard denies for subagent calls and labels them with the agent type', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'u',
      agent_id: 'a1',
      agent_type: 'reviewer',
      tool_input: { command: 'rm -rf /' }
    })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(list.every((d) => d.agent === 'reviewer' && d.agentId === 'a1')).toBe(true)
  })

  it('guard denies malformed input without throwing', async () => {
    const { hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', null)
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('a throwing emitter never breaks the guard or tracking hooks', async () => {
    const hooks = buildHooks(() => {
      throw new Error('queue broke')
    }, '/w')
    await expect(
      call(hooks, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: { file_path: 'a.ts' } })
    ).resolves.toEqual({})
    await expect(
      call(hooks, 'PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'u' })
    ).resolves.toEqual({})
  })

  it('PostToolUse and SubagentStop map to tool-finished and agent-finished', async () => {
    const { list, hooks } = drafts()
    await call(hooks, 'PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'u', duration_ms: 12 })
    await call(hooks, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'reviewer',
      last_assistant_message: 'done'
    })
    expect(list).toMatchObject([
      { type: 'tool-finished', durationMs: 12, denied: false },
      { type: 'agent-finished', summary: 'done', agent: 'reviewer' }
    ])
  })
})

describe('image prompts', () => {
  it('keeps a plain text prompt without images', () => {
    expect(buildPrompt('hello')).toBe('hello')
    expect(buildPrompt('hello', [])).toBe('hello')
  })

  it('sends one user message with the images before the text', async () => {
    const prompt = buildPrompt('what is this?', [{ mediaType: 'image/png', data: 'AAAA' }])
    if (typeof prompt === 'string') throw new Error('expected a message stream')
    const messages = []
    for await (const m of prompt) messages.push(m)
    expect(messages).toEqual([
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'what is this?' }
          ]
        }
      }
    ])
  })

  it('gives an image-only message a short text and hands the stream to the SDK', async () => {
    state.script = async function* () {}
    await collect(run({ prompt: '  ', images: [{ mediaType: 'image/gif', data: 'R0lG' }] }))
    const prompt = (state.captured as unknown as { prompt: AsyncIterable<{ message: { content: { type: string; text?: string }[] } }> }).prompt
    const first = await prompt[Symbol.asyncIterator]().next()
    expect(first.value?.message.content.at(-1)).toEqual({ type: 'text', text: 'See the attached image.' })
  })
})
