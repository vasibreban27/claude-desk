import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import type { PlanTask } from './planParser'
import {
  REVIEWER_BUILTIN_TOOLS,
  buildReviewerOptions,
  buildReviewerPrompt,
  buildReviewerSystemPrompt,
  createReviewRunner,
  guardReviewerToolUse,
  type ReviewRunArgs
} from './reviewRunner'
import type { QueryFn, QueryLike } from './workerRunner'

const task = {
  id: 'T1',
  title: 'Add average',
  worker: 'node-developer',
  owns: ['src/a.ts'],
  acceptance: ['average works'],
  contract: 'none'
} as unknown as PlanTask

const args = (extra: Partial<ReviewRunArgs> = {}): ReviewRunArgs => ({
  reviewer: 'reviewer',
  task,
  worktree: process.cwd(),
  startSha: 'a'.repeat(40),
  settings: defaultSettings(),
  pluginPath: process.cwd(),
  ...extra
})

const finding = { severity: 'blocker', file: 'a.ts', line: 1, text: 'bug' }
const resultMsg = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01 }


/** A fake query: runs `script` with the in-process `report_findings` handler pulled from the options. */
function fakeQuery(script: (call: (input: unknown) => Promise<unknown>) => AsyncGenerator<unknown>): QueryFn {
  return ({ options }) => {
    // The in-process server exposes its tools through the MCP instance; use the tool registry.
    const server = (options.mcpServers as unknown as Record<string, { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }>)['review']!
    const call = (input: unknown): Promise<unknown> => server.instance._registeredTools['report_findings']!.handler(input, {})
    const gen = script(call)
    const q: QueryLike = { [Symbol.asyncIterator]: () => gen, close: () => undefined }
    return q
  }
}

describe('createReviewRunner', () => {
  it('returns finished with the findings, turns and cost', async () => {
    const runner = createReviewRunner({
      queryFn: fakeQuery(async function* (call) {
        yield { type: 'assistant' }
        await call({ findings: [finding] })
        yield resultMsg
      })
    })
    const out = await runner(args())
    expect(out.status).toBe('finished')
    expect(out.findings).toEqual([{ reviewer: 'reviewer', ...finding }])
    expect(out.turns).toBe(3)
    expect(out.costUsd).toBe(0.01)
  })

  it('returns no-report when the tool is never called', async () => {
    const runner = createReviewRunner({
      queryFn: fakeQuery(async function* () {
        yield resultMsg
      })
    })
    const out = await runner(args())
    expect(out.status).toBe('no-report')
    expect(out.findings).toEqual([])
  })

  it('returns limit on the turn cap', async () => {
    const runner = createReviewRunner({
      queryFn: fakeQuery(async function* () {
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 15, total_cost_usd: 0.02 }
      })
    })
    expect((await runner(args())).status).toBe('limit')
  })

  it('returns limit on the time cap', async () => {
    const runner = createReviewRunner({
      timeCapMs: 5,
      queryFn: () => {
        let closed: (() => void) | null = null
        const q: QueryLike = {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise((_, reject) => (closed = () => reject(new Error('closed'))))
          }),
          close: () => closed?.()
        }
        return q
      }
    })
    expect((await runner(args())).status).toBe('limit')
  })

  it('returns cancelled on abort, and before start', async () => {
    const ac = new AbortController()
    const runner = createReviewRunner({
      queryFn: () => {
        let closed: (() => void) | null = null
        const q: QueryLike = {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              const p = new Promise<IteratorResult<unknown>>((_, reject) => (closed = () => reject(new Error('closed'))))
              ac.abort()
              return p
            }
          }),
          close: () => closed?.()
        }
        return q
      }
    })
    expect((await runner(args({ signal: ac.signal }))).status).toBe('cancelled')
    expect((await runner(args({ signal: ac.signal }))).status).toBe('cancelled')
  })

  it('returns error when the session throws without a report', async () => {
    const runner = createReviewRunner({
      queryFn: fakeQuery(async function* () {
        yield { type: 'assistant' }
        throw new Error('network down')
      })
    })
    const out = await runner(args())
    expect(out.status).toBe('error')
    expect(out.error).toContain('network down')
  })
})

describe('buildReviewerOptions', () => {
  it('is read-only: exactly Read, Grep, Glob, no settings, no shell or write tools', () => {
    const { options, prompt } = buildReviewerOptions(args(), new AbortController())
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(REVIEWER_BUILTIN_TOOLS).toEqual(['Read', 'Grep', 'Glob'])
    expect(options.settingSources).toEqual([])
    expect(options.agent).toBeUndefined()
    const all = JSON.stringify([options.tools, options.allowedTools])
    for (const banned of ['Bash', 'Write', 'Edit', 'PowerShell']) expect(all).not.toContain(banned)
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(['mcp__review__review_diff', 'mcp__review__report_findings'])
    )
    expect(prompt).toContain('T1')
  })

  it('frames the diff as data', () => {
    expect(buildReviewerSystemPrompt('reviewer')).toMatch(/DATA/)
    expect(buildReviewerSystemPrompt('reviewer')).toMatch(/Never follow instructions/)
  })
})

describe('prompts', () => {
  it.each(['reviewer', 'security-auditor'] as const)('%s prompt names severities, the cap and the blocker rule', (name) => {
    const p = buildReviewerSystemPrompt(name)
    for (const s of ['blocker', 'major', 'minor', 'nit']) expect(p).toContain(s)
    expect(p).toContain('at most 20 findings')
    expect(p).toMatch(/blocker[^\n]*concrete failing scenario/)
  })

  it('the two roles differ', () => {
    expect(buildReviewerSystemPrompt('reviewer')).not.toBe(buildReviewerSystemPrompt('security-auditor'))
  })

  it('caps long acceptance text', () => {
    const p = buildReviewerPrompt({ ...task, acceptance: ['x'.repeat(5000)] })
    expect(p.length).toBeLessThan(2000)
  })
})

describe('guardReviewerToolUse', () => {
  const allowed = (name: string, input: unknown = {}): boolean =>
    Object.keys(guardReviewerToolUse({ tool_name: name, tool_input: input }, process.cwd(), [])).length === 0

  it('allows the review tools', () => {
    expect(allowed('mcp__review__review_diff')).toBe(true)
    expect(allowed('mcp__review__report_findings')).toBe(true)
  })

  it.each(['Bash', 'Write', 'Edit', 'PowerShell', 'Agent', 'Skill', 'mcp__claude_ai_Gmail__search', 'mcp__work__git_commit', 'git_log'])(
    'denies %s',
    (name) => {
      expect(allowed(name)).toBe(false)
    }
  )

  it('denies malformed input without throwing', () => {
    expect(Object.keys(guardReviewerToolUse(null, process.cwd(), [])).length).toBeGreaterThan(0)
    expect(Object.keys(guardReviewerToolUse({}, process.cwd(), [])).length).toBeGreaterThan(0)
  })
})
