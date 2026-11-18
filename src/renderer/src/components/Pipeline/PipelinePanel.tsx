import { useEffect, useRef, useState } from 'react'
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

export function stageLabel(task: Pick<PipelineTaskView, 'stage' | 'fixRounds'>): string | null {
  if (task.stage === null) return null
  if (task.stage === 'fixing') return `fixing, round ${task.fixRounds ?? 1}`
  return task.fixRounds ? `${task.stage}, round ${task.fixRounds}` : task.stage
}

function Findings({ findings }: { findings: NonNullable<PipelineTaskView['findings']> }) {
  return (
    <div className="pipeline__findings">
      <p>
        {findings.blocking} blocking, {findings.minor} minor
      </p>
      {findings.items.length > 0 && (
        <ul>
          {findings.items.slice(0, 20).map((f, i) => (
            <li key={i}>
              {f.severity} · {f.reviewer} · {f.line === null ? f.file : `${f.file}:${f.line}`}: {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TaskRow({ task }: { task: PipelineTaskView }) {
  const stage = stageLabel(task)
  return (
    <li className="pipeline__task">
      <div className="pipeline__task-head">
        <strong>{task.taskId}</strong> {task.title}
        <span className={`pipeline__status pipeline__status--${task.status}`}>{task.status}</span>
        {stage && <span className="pipeline__badge">{stage}</span>}
        {!stage && task.fixRounds !== null && task.fixRounds > 0 && (
          <span className="pipeline__badge">fix rounds: {task.fixRounds}</span>
        )}
        {task.status === 'done' && (
          <span className="pipeline__badge">{task.findings ? 'Reviewed and merged' : 'Merged, not reviewed'}</span>
        )}
      </div>
      <div className="pipeline__muted">
        {task.commit && <span>commit {task.commit}</span>}
        {task.checks && <span>checks {task.checks}</span>}
        {task.durationMs !== null && <span>{formatDuration(task.durationMs)}</span>}
        {task.costUsd !== null && <span>~${task.costUsd.toFixed(4)}</span>}
      </div>
      {task.reason && <p className="pipeline__reason">{task.reason}</p>}
      {task.findings && <Findings findings={task.findings} />}
    </li>
  )
}

function DiscardConfirm({
  run,
  discarding,
  onConfirm,
  onClose
}: {
  run: PipelineRunView
  discarding: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  const prefix = run.integrationBranch.replace(/^run\//, '')
  return (
    <div
      role="alertdialog"
      aria-labelledby="discard-title"
      aria-describedby="discard-desc"
      className="pipeline__confirm"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !discarding) onClose()
      }}
    >
      <h4 id="discard-title">Discard this run?</h4>
      <div id="discard-desc">
        <p>This removes the run&apos;s worktrees, branches and records:</p>
        <ul>
          <li>
            integration branch <code>{run.integrationBranch}</code>
          </li>
          {run.tasks.map((t) => (
            <li key={t.taskId}>
              task branch <code>{`task/${prefix}-${t.taskId.toLowerCase()}`}</code>
            </li>
          ))}
        </ul>
        <p>
          Commits on these branches are lost. The base branch <code>{run.baseBranch}</code> is not touched.
        </p>
      </div>
      <div className="pipeline__actions">
        <button type="button" className="pipeline__btn" ref={cancelRef} disabled={discarding} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="pipeline__btn pipeline__btn--danger" disabled={discarding} onClick={onConfirm}>
          {discarding ? 'Discarding...' : 'Discard'}
        </button>
      </div>
    </div>
  )
}

const SUMMARY_ORDER: PipelineTaskView['status'][] = ['running', 'queued', 'done', 'failed', 'blocked', 'cancelled']

export function summarize(tasks: PipelineTaskView[]): { counts: string; cost: string | null } {
  const counts = SUMMARY_ORDER.map((st) => [st, tasks.filter((t) => t.status === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${st}`)
    .join(', ')
  const costs = tasks.flatMap((t) => (t.costUsd === null ? [] : [t.costUsd]))
  const cost = costs.length > 0 ? `~$${costs.reduce((a, b) => a + b, 0).toFixed(4)} total` : null
  return { counts, cost }
}

function RunView({
  run,
  cancelling,
  cancelError,
  discarding,
  discardError,
  onCancel,
  onDiscard
}: {
  run: PipelineRunView
  cancelling: boolean
  cancelError: string | null
  discarding: boolean
  discardError: string | null
  onCancel: () => void
  onDiscard: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const summary = summarize(run.tasks)
  const canDiscard = !run.active && run.status !== 'running'
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
        {canDiscard && !confirming && (
          <button type="button" className="pipeline__btn" onClick={() => setConfirming(true)}>
            Discard
          </button>
        )}
      </div>
      {canDiscard && confirming && (
        <DiscardConfirm
          run={run}
          discarding={discarding}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            void onDiscard().then(() => setConfirming(false))
          }}
        />
      )}
      {discardError && (
        <p role="alert" className="pipeline__error">
          {discardError}
        </p>
      )}
      {(summary.counts || summary.cost) && (
        <p className="pipeline__summary" aria-label="Run summary">
          {[summary.counts, summary.cost].filter(Boolean).join(' · ')}
        </p>
      )}
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
  const plansHeading = useRef<HTMLHeadingElement>(null)
  const onDiscard = async (): Promise<void> => {
    const ok = await p.discard()
    if (ok) plansHeading.current?.focus()
  }
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
      {p.run && (
        <RunView
          run={p.run}
          cancelling={p.cancelling}
          cancelError={p.cancelError}
          discarding={p.discarding}
          discardError={p.discardError}
          onCancel={() => void p.cancel()}
          onDiscard={onDiscard}
        />
      )}
      <h3 ref={plansHeading} tabIndex={-1}>
        Plans
      </h3>
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
