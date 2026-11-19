import { randomUUID } from 'node:crypto'
import type { RunStore } from '../db/runStore'
import type { PipelineUsageInput } from './orchestrator'

/**
 * Records each pipeline worker and reviewer session in the run store, so the Usage tab counts the pipeline
 * too. One session is one row; the agent row carries the worker or reviewer name.
 */
export function pipelineUsageRecorder(
  runStore: Pick<RunStore, 'recordRun'>,
  newId: () => string = randomUUID
): (input: PipelineUsageInput) => void {
  return ({ projectId, kind, agent, startedAt, usage }) => {
    const totals =
      usage.models.length > 0
        ? usage.models.reduce(
            (a, m) => ({
              inputTokens: a.inputTokens + m.inputTokens,
              outputTokens: a.outputTokens + m.outputTokens,
              cacheReadTokens: a.cacheReadTokens + m.cacheReadTokens,
              cacheCreationTokens: a.cacheCreationTokens + m.cacheCreationTokens
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
          )
        : usage.mainTokens
    runStore.recordRun({
      runId: newId(),
      projectId,
      kind,
      startedAt,
      usage,
      agents: [{ agent, steps: 1, approximate: false, ...totals }]
    })
  }
}
