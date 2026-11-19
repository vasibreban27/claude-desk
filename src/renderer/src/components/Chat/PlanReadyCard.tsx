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
    <div className={problem ? 'plan-card plan-card--problem' : 'plan-card'} role="group" aria-label="Plan ready">
      <div className="plan-card__body">
        <p className="plan-card__title">
          {problem ? 'Plan needs a fix' : 'Plan ready'} <code>docs/plans/{planFile}</code>
        </p>
        {problem ? (
          <p role="alert" className="plan-card__text">
            The pipeline cannot run it yet: {problem}. Ask the planner to fix it.
          </p>
        ) : (
          <p className="plan-card__text">
            Workers build each task on its own branch, then checks and reviewers run. Your current branch is not changed.
          </p>
        )}
        {error && (
          <p role="alert" className="plan-card__error">
            {error}
          </p>
        )}
      </div>
      <div className="plan-card__actions">
        <button type="button" className="plan-card__start" onClick={() => void start()} disabled={working || problem !== null}>
          {working ? 'Starting…' : 'Start pipeline'}
        </button>
        <button type="button" className="plan-card__dismiss" onClick={onDismiss} disabled={working}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
