import type { TraceEvent, TraceRole } from '@shared/ipc'

/** Builds the CLI-like tree of a run: task -> session -> steps, with subagent steps nested under their Agent call. */

export type TextEvent = Extract<TraceEvent, { kind: 'text' }>
export type ToolEvent = Extract<TraceEvent, { kind: 'tool' }>
export type ResultEvent = Extract<TraceEvent, { kind: 'result' }>
export type NoteEvent = Extract<TraceEvent, { kind: 'note' }>
export type TurnEvent = Extract<TraceEvent, { kind: 'turn' }>

export type Step =
  | { type: 'text'; key: string; agent: string; event: TextEvent }
  | { type: 'tool'; key: string; agent: string; call: ToolEvent; result: ResultEvent | null; children: Step[] }
  | { type: 'turn'; key: string; agent: string; event: TurnEvent }

export interface Session {
  type: 'session'
  key: string
  role: TraceRole
  label: string
  agent: string
  steps: Step[]
}

export type GroupItem = Session | { type: 'note'; key: string; event: NoteEvent }

export interface Group {
  /** Null: chat runs and run-level pipeline lines. */
  taskId: string | null
  items: GroupItem[]
}

export function buildTree(events: readonly TraceEvent[]): Group[] {
  const groups: Group[] = []
  const groupOf = new Map<string, Group>()
  const sessions = new Map<string, Session>()
  const tools = new Map<string, Extract<Step, { type: 'tool' }>>()

  const group = (taskId: string | null): Group => {
    const k = taskId ?? ''
    let g = groupOf.get(k)
    if (!g) {
      g = { taskId, items: [] }
      groupOf.set(k, g)
      groups.push(g)
    }
    return g
  }

  for (const e of events) {
    const g = group(e.taskId)
    if (e.kind === 'note') {
      g.items.push({ type: 'note', key: `n${e.seq}`, event: e })
      continue
    }
    const sk = `${e.taskId ?? ''}|${e.session}`
    let s = sessions.get(sk)
    if (!s) {
      s = { type: 'session', key: `s${e.seq}`, role: e.role, label: e.session, agent: e.agent, steps: [] }
      sessions.set(sk, s)
      g.items.push(s)
    }
    const into = (e.parentId !== null ? tools.get(e.parentId)?.children : undefined) ?? s.steps

    if (e.kind === 'result') {
      const call = tools.get(e.toolUseId)
      if (call) call.result = e
      continue
    }
    if (e.kind === 'tool') {
      const step: Extract<Step, { type: 'tool' }> = { type: 'tool', key: `t${e.seq}`, agent: e.agent, call: e, result: null, children: [] }
      tools.set(e.toolUseId, step)
      into.push(step)
    } else if (e.kind === 'text') {
      into.push({ type: 'text', key: `x${e.seq}`, agent: e.agent, event: e })
    } else {
      into.push({ type: 'turn', key: `u${e.seq}`, agent: e.agent, event: e })
    }
  }
  return groups
}

export interface TraceFilter {
  taskId: string | null
  agent: string | null
  errorsOnly: boolean
}

export const NO_FILTER: TraceFilter = { taskId: null, agent: null, errorsOnly: false }

export function isErrorStep(step: Step): boolean {
  if (step.type === 'tool') return step.result !== null && !step.result.ok
  if (step.type === 'turn') return !step.event.ok
  return false
}

function keepStep(step: Step, f: TraceFilter): Step | null {
  const children = step.type === 'tool' ? step.children.map((c) => keepStep(c, f)).filter((c): c is Step => c !== null) : []
  const self = (f.agent === null || step.agent === f.agent) && (!f.errorsOnly || isErrorStep(step))
  if (!self && children.length === 0) return null
  return step.type === 'tool' ? { ...step, children } : step
}

/** Applies the filters; empty sessions and groups are left out. */
export function filterTree(groups: readonly Group[], f: TraceFilter): Group[] {
  if (f.taskId === null && f.agent === null && !f.errorsOnly) return [...groups]
  const out: Group[] = []
  for (const g of groups) {
    if (f.taskId !== null && g.taskId !== f.taskId) continue
    const items: GroupItem[] = []
    for (const item of g.items) {
      if (item.type === 'note') {
        const tone = item.event.tone
        if (f.agent !== null) continue
        if (f.errorsOnly && tone !== 'error' && tone !== 'denied') continue
        items.push(item)
        continue
      }
      const steps = item.steps.map((s) => keepStep(s, f)).filter((s): s is Step => s !== null)
      if (steps.length > 0) items.push({ ...item, steps })
    }
    if (items.length > 0) out.push({ ...g, items })
  }
  return out
}

/** Task ids and agent names present in a run, for the filter menus. */
export function filterOptions(events: readonly TraceEvent[]): { tasks: string[]; agents: string[] } {
  const tasks = new Set<string>()
  const agents = new Set<string>()
  for (const e of events) {
    if (e.taskId !== null) tasks.add(e.taskId)
    if (e.kind !== 'note') agents.add(e.agent)
  }
  return { tasks: [...tasks], agents: [...agents].sort() }
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** `mcp__work__run_command` -> `run_command`. */
export function shortTool(tool: string): string {
  const i = tool.lastIndexOf('__')
  return tool.startsWith('mcp__') && i > 4 ? tool.slice(i + 2) : tool
}
