import type { PipelineRunView, PipelineTaskView, PlanEntry } from '@shared/ipc'
import type { UsePipeline } from '../../hooks/usePipeline'
import './pipeline.css'

export type PipelinePanelProps = Omit<UsePipeline, 'projectId' | 'reloadPlans'> & { reloadPlans?: () => void }

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${s % 60} s`
}

function PlanItem({ plan, disabled, onStart }: { plan: PlanEntry; disabled: boolean; onStart: () => void }) {
  return (
    <li className="pipeline__plan">
      <div className="pipeline__plan-head">
        <div>
          <strong>{plan.title || plan.file}</strong>
          <span className="pipeline__badge">{plan.format}</span>
          <div className="pipeline__muted">
            {plan.file} · {plan.taskCount} {plan.taskCount === 1 ? 'task' : 'tasks'} · {plan.waveCount}{' '}
            {plan.waveCount === 1 ? 'wave' : 'waves'}
          </div>
        </div>
        <button
          type="button"
          className="pipeline__btn"
          disabled={disabled || !plan.ok}
          aria-label={`Start ${plan.file}`}
          onClick={onStart}
        >
          Start
        </button>
      </div>
      {plan.errorCount > 0 && (
        <div className="pipeline__plan-errors">
          <p className="pipeline__errors-title">
            {plan.errorCount} {plan.errorCount === 1 ? 'error' : 'errors'}
          </p>
          <ul>
            {plan.errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

function TaskRow({ task }: { task: PipelineTaskView }) {
  return (
    <li className="pipeline__task">
      <div className="pipeline__task-head">
        <strong>{task.taskId}</strong> {task.title}
        <span className={`pipeline__status pipeline__status--${task.status}`}>{task.status}</span>
        {task.status === 'done' && <span className="pipeline__badge">Committed, not reviewed</span>}
      </div>
      <div className="pipeline__muted">
        {task.commit && <span>commit {task.commit}</span>}
        {task.checks && <span>checks {task.checks}</span>}
        {task.durationMs !== null && <span>{formatDuration(task.durationMs)}</span>}
        {task.costUsd !== null && <span>~${task.costUsd.toFixed(4)}</span>}
      </div>
      {task.reason && <p className="pipeline__reason">{task.reason}</p>}
    </li>
  )
}

function RunView({
  run,
  cancelling,
  cancelError,
  onCancel
}: {
  run: PipelineRunView
  cancelling: boolean
  cancelError: string | null
  onCancel: () => void
}) {
  const waves = [...new Set(run.tasks.map((t) => t.wave))].sort((a, b) => a - b)
  return (
    <section aria-label="Latest run" className="pipeline__run">
      <div className="pipeline__run-head">
        <h3>
          {run.planFile}{' '}
          <span className="pipeline__status">
            {run.status === 'done' ? 'tasks committed, not reviewed' : run.status}
          </span>
        </h3>
        {run.active && (
          <button type="button" className="pipeline__btn" disabled={cancelling} onClick={onCancel}>
            {cancelling ? 'Cancelling...' : 'Cancel run'}
          </button>
        )}
      </div>
      <p role="status" className="pipeline__muted">
        Work is merged into <code>{run.integrationBranch}</code> only. Nothing is merged into{' '}
        <code>{run.baseBranch}</code> or pushed.
      </p>
      {cancelError && (
        <p role="alert" className="pipeline__error">
          {cancelError}
        </p>
      )}
      {waves.map((w) => (
        <div key={w}>
          <h4>Wave {w}</h4>
          <ul className="pipeline__list">
            {run.tasks
              .filter((t) => t.wave === w)
              .map((t) => (
                <TaskRow key={t.taskId} task={t} />
              ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

export function PipelinePanel(p: PipelinePanelProps) {
  const busy = p.starting || (p.run?.active ?? false)
  return (
    <section className="pipeline" aria-label="Pipeline">
      {p.startError && (
        <p role="alert" className="pipeline__error">
          {p.startError}
        </p>
      )}
      {p.runError && (
        <p role="alert" className="pipeline__error">
          {p.runError}
        </p>
      )}
      {p.runLoading && !p.run && <p className="pipeline__muted">Loading run…</p>}
      {p.run && <RunView run={p.run} cancelling={p.cancelling} cancelError={p.cancelError} onCancel={() => void p.cancel()} />}
      <h3>Plans</h3>
      {p.plansError && (
        <p role="alert" className="pipeline__error">
          {p.plansError}
        </p>
      )}
      {p.plansLoading && !p.plans && <p className="pipeline__muted">Loading plans…</p>}
      {p.plans && p.plans.length === 0 && <p className="pipeline__muted">No plans found in docs/plans.</p>}
      {p.plans && p.plans.length > 0 && (
        <ul className="pipeline__list">
          {p.plans.map((plan) => (
            <PlanItem key={plan.file} plan={plan} disabled={busy} onStart={() => void p.start(plan.file)} />
          ))}
        </ul>
      )}
    </section>
  )
}
