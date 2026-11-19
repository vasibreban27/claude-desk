import { z } from 'zod'

/** Who wrote a pipeline log line: a task's worker, its fix round, a reviewer, or the orchestrator itself. */
export const PIPELINE_LOG_ROLES = ['worker', 'fix', 'reviewer', 'pipeline'] as const
export type PipelineLogRole = (typeof PIPELINE_LOG_ROLES)[number]
export type PipelineLogTone = 'info' | 'ok' | 'error' | 'denied'

/** One short line of live pipeline progress. Never raw model text or file contents. */
export interface PipelineLogEntry {
  projectId: string
  runId: string
  /** Increasing per run. */
  seq: number
  /** ISO-8601. */
  at: string
  /** Null for run-level lines. */
  taskId: string | null
  role: PipelineLogRole
  /** For reviewers: the reviewer name. */
  agent: string | null
  text: string
  tone: PipelineLogTone
}

export const PIPELINE_LOG_TEXT_MAX = 500
export const PIPELINE_LOG_MAX = 500

export const pipelineLogRequestSchema = z.object({ projectId: z.uuid() })
export type PipelineLogRequest = z.infer<typeof pipelineLogRequestSchema>
export type PipelineLogResult = PipelineLogEntry[]
