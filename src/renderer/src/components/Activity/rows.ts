import type { ActivityEvent } from '@shared/ipc'

export type ToolState = 'running' | 'done' | 'denied' | 'ended'

export type ActivityRow =
  | {
      kind: 'tool'
      key: string
      at: string
      agent: string
      subagent: boolean
      tool: string
      summary: string
      state: ToolState
      durationMs: number | null
    }
  | { kind: 'agent-finished'; key: string; at: string; agent: string; subagent: boolean; summary: string }
  | { kind: 'run-started'; key: string; at: string }
  | {
      kind: 'run-finished'
      key: string
      at: string
      status: 'success' | 'error'
      costUsd: number | null
      durationMs: number | null
    }

/** Turns the ordered event list into display rows: a tool start and finish become one row. */
export function buildRows(events: ActivityEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  const open = new Map<string, Extract<ActivityRow, { kind: 'tool' }>>()
  for (const e of events) {
    const key = `${e.runId}:${e.seq}`
    const subagent = e.agent !== 'main'
    switch (e.type) {
      case 'run-started':
        rows.push({ kind: 'run-started', key, at: e.at })
        break
      case 'tool-started': {
        const row: Extract<ActivityRow, { kind: 'tool' }> = {
          kind: 'tool',
          key,
          at: e.at,
          agent: e.agent,
          subagent,
          tool: e.tool,
          summary: e.summary,
          state: 'running',
          durationMs: null
        }
        open.set(`${e.runId}:${e.toolUseId}`, row)
        rows.push(row)
        break
      }
      case 'tool-finished': {
        const row = open.get(`${e.runId}:${e.toolUseId}`)
        if (row) {
          row.state = e.denied ? 'denied' : 'done'
          row.durationMs = e.durationMs
          open.delete(`${e.runId}:${e.toolUseId}`)
        } else {
          rows.push({
            kind: 'tool',
            key,
            at: e.at,
            agent: e.agent,
            subagent,
            tool: e.tool,
            summary: '',
            state: e.denied ? 'denied' : 'done',
            durationMs: e.durationMs
          })
        }
        break
      }
      case 'agent-finished':
        rows.push({ kind: 'agent-finished', key, at: e.at, agent: e.agent, subagent, summary: e.summary })
        break
      case 'run-finished':
        // Tools still open when the run ends (for example a failed tool) will never finish.
        for (const row of open.values()) row.state = 'ended'
        open.clear()
        rows.push({
          kind: 'run-finished',
          key,
          at: e.at,
          status: e.status,
          costUsd: e.costUsd,
          durationMs: e.durationMs
        })
        break
    }
  }
  return rows
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatCost(costUsd: number | null): string {
  return costUsd === null ? 'cost unknown' : `~$${costUsd.toFixed(4)}`
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour12: false })
}
