import { useState } from 'react'
import type { PipelineStartResult } from '@shared/ipc'

const START_ERRORS: Record<string, string> = {
  busy: 'A pipeline run is already active for this project.',
  'detached-head': 'The project is on a detached HEAD: check out a branch first.',
  'no-toolkit': 'The toolkit is not available.',
  'invalid-plan': 'The plan is not valid.',
  'not-found': 'The plan file was not found.'
}

export interface PlanReadyCardProps {
  projectId: string
  planFile: string
  problem: string | null
  onStarted: () => void
  onDismiss: () => void
}

/** Shown when the planner wrote a plan: starting the pipeline is the user's click. */
export function PlanReadyCard({ projectId, planFile, problem, onStarted, onDismiss }: PlanReadyCardProps) {
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  async function start() {
    setWorking(true)
    setError(null)
    try {
      const r: PipelineStartResult = await window.api.pipelineStart({ projectId, planFile })
      if (r.ok) onStarted()
      else setError(r.message ?? START_ERRORS[r.error] ?? `Could not start (${r.error}).`)
    } catch {
      setError('Could not start the pipeline.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="chat__proposal" role="group" aria-label="Plan ready">
      <p>
        Plan written: <strong>docs/plans/{planFile}</strong>
      </p>
      {problem ? (
        <p role="alert">The pipeline cannot run it yet ({problem}). Ask the planner to fix the plan.</p>
      ) : (
        <p>Start the pipeline: workers build each task on its own branch, then checks and reviewers run.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void start()} disabled={working || problem !== null}>
        Start pipeline
      </button>{' '}
      <button type="button" onClick={onDismiss} disabled={working}>
        Dismiss
      </button>
    </div>
  )
}
