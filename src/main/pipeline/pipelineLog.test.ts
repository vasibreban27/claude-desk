import { describe, expect, it, vi } from 'vitest'
import { PIPELINE_LOG_MAX, PIPELINE_LOG_TEXT_MAX, type PipelineLogEntry } from '../../shared/pipelineLog'
import { createPipelineLog, logToolUse, relativize, shortTool, toolLine } from './pipelineLog'

const WT = 'C:\\Users\\me\\work\\.worktrees\\abcd1234-t2'
const pre = (tool_name: string, tool_input: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_use_id: 'toolu_1',
  tool_input
})
const DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'no' } }

describe('createPipelineLog', () => {
  it('stamps project, run, seq and time, emits, and keeps only the latest run', () => {
    const emitted: PipelineLogEntry[] = []
    const log = createPipelineLog((e) => emitted.push(e), () => new Date('2026-11-18T12:00:00Z'))
    log.add('p', { runId: 'r1', taskId: 'T1', role: 'worker', text: 'Read app/db.py' })
    log.add('p', { runId: 'r1', taskId: null, role: 'pipeline', text: 'run done', tone: 'ok' })
    expect(log.history('p').map((e) => [e.seq, e.text, e.tone])).toEqual([
      [0, 'Read app/db.py', 'info'],
      [1, 'run done', 'ok']
    ])
    expect(emitted[0]).toMatchObject({ projectId: 'p', runId: 'r1', at: '2026-11-18T12:00:00.000Z' })
    log.add('p', { runId: 'r2', taskId: 'T1', role: 'worker', text: 'new run' })
    expect(log.history('p').map((e) => e.text)).toEqual(['new run'])
    expect(log.history('other')).toEqual([])
  })

  it('caps lines and text, single-lines it, and survives a throwing emitter', () => {
    const log = createPipelineLog(() => {
      throw new Error('window gone')
    })
    for (let i = 0; i < PIPELINE_LOG_MAX + 5; i++) log.add('p', { runId: 'r', taskId: 'T1', role: 'worker', text: `line ${i}` })
    expect(log.history('p')).toHaveLength(PIPELINE_LOG_MAX)
    log.add('p', { runId: 'r', taskId: 'T1', role: 'worker', text: `a\nb ${'x'.repeat(500)}` })
    const last = log.history('p').at(-1)
    expect(last?.text.startsWith('a b ')).toBe(true)
    expect(last?.text.length).toBe(PIPELINE_LOG_TEXT_MAX)
  })
})

describe('tool lines', () => {
  it('shortens work tool names and makes paths relative to the worktree', () => {
    expect(shortTool('mcp__work__run_command')).toBe('run_command')
    expect(shortTool('Read')).toBe('Read')
    expect(relativize(`${WT}\\app\\db.py`, WT)).toBe('app/db.py')
    expect(relativize('C:/Users/me/work/.worktrees/abcd1234-t2/app/x.py', WT)).toBe('app/x.py')
  })

  it('logs started tools and denials, skips self-reporting work tools', () => {
    const lines: { text: string; tone?: string }[] = []
    logToolUse((l) => lines.push(l), pre('Write', { file_path: `${WT}\\app\\db.py`, content: 'secret body' }), {}, WT)
    logToolUse((l) => lines.push(l), pre('Bash', { command: 'rm -rf /' }), DENY, WT)
    logToolUse((l) => lines.push(l), pre('mcp__work__run_command', { command: 'npm' }), {}, WT)
    expect(lines.map((l) => l.text)).toEqual(['Write app/db.py', 'Bash denied: no'])
    expect(lines[1]?.tone).toBe('denied')
    expect(lines.some((l) => l.text.includes('secret body'))).toBe(false)
  })

  it('shows what Grep and Glob search for, and one denial line with the target and the guard reason', () => {
    const lines: { text: string; tone?: string }[] = []
    logToolUse((l) => lines.push(l), pre('Grep', { pattern: 'class Ticket', path: WT }), {}, WT)
    logToolUse((l) => lines.push(l), pre('Glob', { pattern: '**/*.java', path: `${WT}\\src` }), {}, WT)
    const outside = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `Path is outside the worktree ${WT}.`
      }
    }
    logToolUse((l) => lines.push(l), pre('Glob', { pattern: '*', path: 'C:/Users/me/.m2' }), outside, WT)
    expect(lines.map((l) => l.text)).toEqual([
      'Grep class Ticket',
      'Glob **/*.java in src',
      'Glob * in C:/Users/me/.m2 denied: Path is outside the worktree .'
    ])
    expect(lines[2]?.tone).toBe('denied')
  })

  it('never throws and ignores unknown input', () => {
    const sink = vi.fn()
    expect(() => logToolUse(sink, null, {}, WT)).not.toThrow()
    expect(toolLine(null, WT)).toBeNull()
    expect(sink).not.toHaveBeenCalled()
  })
})
