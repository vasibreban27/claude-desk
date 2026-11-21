import {
  TRACE_EVENTS_PER_RUN_MAX,
  TRACE_KEEP_MS,
  TRACE_KEEP_RUNS,
  TRACE_RUNS_LIST_MAX,
  type TraceEvent,
  type TracePush,
  type TraceRun,
  type TraceRunStatus,
  type TraceSource,
  type TraceTone
} from '../../shared/trace'
import type { TraceStore } from '../db/traceStore'
import { oneLine, redact } from './preview'
import { createSessionRecorder, type TraceDraft, type TraceSessionMeta, type TraceSink } from './recorder'

/**
 * Detailed Activity for the whole app: numbers events per run, pushes them live, writes them in batches and
 * deletes old runs. Every method is best effort and never throws into a chat turn or a pipeline run.
 */
export interface TraceHub {
  /** A chat or plan turn starts (pipeline runs are created on their first event). */
  startRun(run: { runId: string; projectId: string; source: TraceSource; title: string }): void
  endRun(runId: string, status: Exclude<TraceRunStatus, 'running'>): void
  /** A recorder for one agent session. */
  session(meta: TraceSessionMeta): TraceSink
  /** A pipeline progress line. */
  note(input: { projectId: string; runId: string; taskId: string | null; text: string; tone?: TraceTone }): void
  runs(projectId: string): TraceRun[]
  events(projectId: string, runId: string): TraceEvent[]
  /** Writes pending events now. */
  flush(): void
  dispose(): void
}

export interface TraceHubDeps {
  /** Absent: live view only, nothing kept. */
  store?: TraceStore
  emit: (push: TracePush) => void
  /** Values to hide (MCP secrets); refreshed when a run starts. */
  loadSecrets?: () => Promise<string[]>
  now?: () => number
  flushMs?: number
  log?: (message: string) => void
}

const BATCH_MAX = 100
const PRUNE_EVERY_MS = 10 * 60 * 1000

interface RunState {
  projectId: string
  nextSeq: number
  count: number
  capped: boolean
}

export function createTraceHub(deps: TraceHubDeps): TraceHub {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const runs = new Map<string, RunState>()
  let pending: TraceEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let secrets: string[] = []
  let lastPrune = 0

  const safe = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (e) {
      log(`activity: ${what} failed: ${e instanceof Error ? e.name : 'unknown'}`)
      return fallback
    }
  }

  const push = (p: TracePush): void => {
    try {
      deps.emit(p)
    } catch {
      // a closed window never breaks a run
    }
  }

  const refreshSecrets = (): void => {
    if (!deps.loadSecrets) return
    deps
      .loadSecrets()
      .then((list) => {
        secrets = list.filter((s) => typeof s === 'string' && s.length >= 6)
      })
      .catch(() => undefined)
  }

  const prune = (force = false): void => {
    const t = now()
    if (!deps.store || (!force && t - lastPrune < PRUNE_EVERY_MS)) return
    lastPrune = t
    safe('cleanup', () => deps.store?.prune(t - TRACE_KEEP_MS, TRACE_KEEP_RUNS), 0)
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const batch = pending
    pending = []
    safe('write', () => deps.store?.insertEvents(batch), undefined)
  }

  const schedule = (): void => {
    if (pending.length >= BATCH_MAX) {
      flush()
      return
    }
    if (timer === null) timer = setTimeout(flush, deps.flushMs ?? 300)
  }

  const runOf = (projectId: string, runId: string, source: TraceSource): RunState => {
    let r = runs.get(runId)
    if (r) return r
    // A run seen for the first time (a new pipeline run, or one resumed after a restart).
    const counters = safe('read', () => deps.store?.runCounters(runId), undefined) ?? { nextSeq: 0, count: 0 }
    r = { projectId, nextSeq: counters.nextSeq, count: counters.count, capped: counters.count >= TRACE_EVENTS_PER_RUN_MAX }
    runs.set(runId, r)
    if (source === 'pipeline') {
      safe('start', () => deps.store?.ensureRun({ runId, projectId, source, title: 'Pipeline run', startedAt: now() }), undefined)
      refreshSecrets()
      prune()
      announce(projectId, runId)
    }
    return r
  }

  const announce = (projectId: string, runId: string): void => {
    const run = safe('read', () => deps.store?.listRuns(projectId, TRACE_RUNS_LIST_MAX).find((x) => x.runId === runId), undefined)
    if (run) push({ type: 'run', run })
  }

  const add = (projectId: string, runId: string, source: TraceSource, draft: TraceDraft): void => {
    const r = runOf(projectId, runId, source)
    if (r.capped) return
    const event = { ...draft, projectId, runId, seq: r.nextSeq++, at: new Date(now()).toISOString() } as TraceEvent
    r.count += 1
    if (r.count >= TRACE_EVENTS_PER_RUN_MAX) {
      r.capped = true
      const last = {
        taskId: null,
        role: draft.role,
        session: draft.session,
        agent: 'app',
        parentId: null,
        kind: 'note',
        text: `Activity limit reached (${TRACE_EVENTS_PER_RUN_MAX} events); later steps are not shown.`,
        tone: 'info',
        projectId,
        runId,
        seq: r.nextSeq++,
        at: event.at
      } as TraceEvent
      pending.push(event, last)
      push({ type: 'event', event })
      push({ type: 'event', event: last })
    } else {
      pending.push(event)
      push({ type: 'event', event })
    }
    schedule()
  }

  if (deps.store) {
    safe('recovery', () => deps.store?.markInterrupted(now()), undefined)
    prune(true)
  }

  return {
    startRun(run) {
      runs.set(run.runId, { projectId: run.projectId, nextSeq: 0, count: 0, capped: false })
      safe('start', () => deps.store?.ensureRun({ ...run, title: oneLine(run.title, 80), startedAt: now() }), undefined)
      refreshSecrets()
      prune()
      const listed = safe('read', () => deps.store?.listRuns(run.projectId, 1)[0], undefined)
      push({
        type: 'run',
        run: listed?.runId === run.runId
          ? listed
          : { runId: run.runId, projectId: run.projectId, source: run.source, title: oneLine(run.title, 80), startedAt: now(), endedAt: null, status: 'running', events: 0 }
      })
    },
    endRun(runId, status) {
      flush()
      safe('end', () => deps.store?.endRun(runId, status, now()), undefined)
      const r = runs.get(runId)
      if (r) announce(r.projectId, runId)
      runs.delete(runId)
    },
    session(meta) {
      const source: TraceSource = meta.role === 'chat' ? 'chat' : meta.role === 'plan' ? 'plan' : 'pipeline'
      return createSessionRecorder(meta, (draft) => add(meta.projectId, meta.runId, source, draft), {
        secrets: () => secrets,
        now
      })
    },
    note(input) {
      try {
        add(input.projectId, input.runId, 'pipeline', {
          taskId: input.taskId,
          role: 'pipeline',
          session: 'pipeline',
          agent: 'pipeline',
          parentId: null,
          kind: 'note',
          text: oneLine(redact(input.text, secrets), 600),
          tone: input.tone ?? 'info'
        })
      } catch {
        // tracking never breaks a run
      }
    },
    runs(projectId) {
      flush()
      return safe('read', () => deps.store?.listRuns(projectId, TRACE_RUNS_LIST_MAX), undefined) ?? []
    },
    events(projectId, runId) {
      flush()
      return safe('read', () => deps.store?.listEvents(projectId, runId), undefined) ?? []
    },
    flush,
    dispose() {
      flush()
    }
  }
}
