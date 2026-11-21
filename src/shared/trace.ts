import { z } from 'zod'

/**
 * Detailed Activity: what every agent did in a Chat, Plan or Pipeline run, like the Claude Code CLI shows it.
 * Only previews are kept (cut and with secrets hidden), and only for a short time (see TRACE_KEEP_*).
 */

export const TRACE_SOURCES = ['chat', 'plan', 'pipeline'] as const
export type TraceSource = (typeof TRACE_SOURCES)[number]

/** Which session in a run wrote the event. */
export const TRACE_ROLES = ['chat', 'plan', 'worker', 'fix', 'reviewer', 'pipeline'] as const
export type TraceRole = (typeof TRACE_ROLES)[number]

export const TRACE_TONES = ['info', 'ok', 'error', 'denied'] as const
export type TraceTone = (typeof TRACE_TONES)[number]

/** Activity older than this is deleted ... */
export const TRACE_KEEP_MS = 2 * 24 * 60 * 60 * 1000
/** ... except each project's latest runs. */
export const TRACE_KEEP_RUNS = 5
/** Runs listed per project. */
export const TRACE_RUNS_LIST_MAX = 30
/** Events kept per run; later events are dropped (one note says so). */
export const TRACE_EVENTS_PER_RUN_MAX = 5000

/** Preview limits. */
export const TRACE_TEXT_MAX = 4096
export const TRACE_INPUT_MAX = 2048
export const TRACE_HEAD_LINES = 40
export const TRACE_TAIL_LINES = 10
export const TRACE_SUMMARY_MAX = 200

const short = z.string().max(200)
const preview = z.string().max(TRACE_TEXT_MAX + 200)

export const traceBodySchema = z.discriminatedUnion('kind', [
  /** The assistant's text. */
  z.object({ kind: z.literal('text'), text: preview }),
  /** A tool call: name, one-line target, input preview and, for edits, a diff preview. */
  z.object({
    kind: z.literal('tool'),
    toolUseId: short,
    tool: short,
    summary: z.string().max(TRACE_SUMMARY_MAX + 10),
    input: z.string().max(TRACE_INPUT_MAX + 200),
    diff: preview.nullable(),
    added: z.number().int().min(0),
    removed: z.number().int().min(0)
  }),
  /** The result of a tool call. */
  z.object({
    kind: z.literal('result'),
    toolUseId: short,
    ok: z.boolean(),
    denied: z.boolean(),
    output: preview,
    durationMs: z.number().int().min(0).nullable()
  }),
  /** A pipeline progress line (wave started, checks passed, merged, ...). */
  z.object({ kind: z.literal('note'), text: z.string().max(600), tone: z.enum(TRACE_TONES) }),
  /** End of one agent session: time, tokens and cost. */
  z.object({
    kind: z.literal('turn'),
    ok: z.boolean(),
    turns: z.number().int().min(0).nullable(),
    durationMs: z.number().int().min(0).nullable(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheTokens: z.number().int().min(0),
    costUsd: z.number().min(0).nullable()
  })
])
export type TraceBody = z.infer<typeof traceBodySchema>
export type TraceKind = TraceBody['kind']

export const traceMetaSchema = z.object({
  projectId: z.string().min(1).max(100),
  runId: z.string().min(1).max(100),
  /** Per run, increasing from 0. */
  seq: z.number().int().min(0),
  /** ISO-8601. */
  at: z.string().max(40),
  /** Pipeline task id; null for chat runs and run-level notes. */
  taskId: z.string().max(100).nullable(),
  role: z.enum(TRACE_ROLES),
  /** Session label inside the run, e.g. "worker", "fix round 1", "reviewer security-auditor". */
  session: z.string().max(120),
  /** "main", a worker or reviewer name, or a subagent type. */
  agent: z.string().max(120),
  /** For subagent events: the toolUseId of the Agent/Task call that started the subagent. */
  parentId: z.string().max(200).nullable()
})

export type TraceEvent = z.infer<typeof traceMetaSchema> & TraceBody

export const traceEventSchema = z.intersection(traceMetaSchema, traceBodySchema)

export const TRACE_RUN_STATUSES = ['running', 'ok', 'error', 'cancelled'] as const
export type TraceRunStatus = (typeof TRACE_RUN_STATUSES)[number]

export interface TraceRun {
  runId: string
  projectId: string
  source: TraceSource
  /** The plan file for pipeline runs, the first words of the message for chat runs. */
  title: string
  /** Epoch ms. */
  startedAt: number
  endedAt: number | null
  status: TraceRunStatus
  events: number
}

export const traceRunsRequestSchema = z.object({ projectId: z.uuid() }).strict()
export type TraceRunsRequest = z.infer<typeof traceRunsRequestSchema>
export type TraceRunsResult = TraceRun[]

export const traceEventsRequestSchema = z.object({ projectId: z.uuid(), runId: z.string().min(1).max(100) }).strict()
export type TraceEventsRequest = z.infer<typeof traceEventsRequestSchema>
export type TraceEventsResult = TraceEvent[]

/** Pushed to every window while runs are going. */
export type TracePush = { type: 'event'; event: TraceEvent } | { type: 'run'; run: TraceRun }
