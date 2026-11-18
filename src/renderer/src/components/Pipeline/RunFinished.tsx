import { useState } from 'react'
import type { PipelineMergeResult, PipelineRunView } from '@shared/ipc'

const MERGE_ERRORS: Record<string, string> = {
  'not-found': 'The run was not found.',
  'not-finished': 'The run is not finished.',
  'wrong-branch': 'The project is not on the base branch.',
  dirty: 'The project has uncommitted changes.',
  'not-fast-forward': 'The base branch moved since the run started.',
  'git-failed': 'Git could not merge the run.'
}

export type MergedInfo = Extract<PipelineMergeResult, { ok: true }> & { runId: string; integrationBranch: string }

/** The end of a successful run: what was built, and the user's click that brings it into the base branch. */
export function RunFinished({
  projectId,
  run,
  onMerged
}: {
  projectId: string
  run: PipelineRunView
  onMerged: (info: MergedInfo) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = run.tasks.filter((t) => t.status === 'done').length
  const blocking = run.tasks.reduce((n, t) => n + (t.findings?.blocking ?? 0), 0)
  const minor = run.tasks.reduce((n, t) => n + (t.findings?.minor ?? 0), 0)
  const reviewed = run.tasks.some((t) => t.findings !== null)

  async function merge() {
    setMerging(true)
    setError(null)
    try {
      const r = await window.api.pipelineMerge({ projectId, runId: run.runId })
      if (r.ok) onMerged({ ...r, runId: run.runId, integrationBranch: run.integrationBranch })
      else setError(r.message ?? MERGE_ERRORS[r.error] ?? 'Could not merge the run.')
    } catch {
      setError('Could not merge the run.')
    } finally {
      setMerging(false)
      setConfirming(false)
    }
  }

  return (
    <div className="pipeline__finished" role="region" aria-label="Run finished">
      <p>
        <strong>Run finished.</strong> {done} of {run.tasks.length} {run.tasks.length === 1 ? 'task' : 'tasks'} built and
        merged into <code>{run.integrationBranch}</code>
        {reviewed ? ` · review: ${blocking} blocking, ${minor} minor` : ' · not reviewed'}.
      </p>
      <p className="pipeline__muted">
        Your project folder still shows <code>{run.baseBranch}</code> without this work until you merge it.
      </p>
      {error && (
        <p role="alert" className="pipeline__error">
          {error}
        </p>
      )}
      {!confirming ? (
        <button type="button" className="pipeline__btn pipeline__btn--primary" onClick={() => setConfirming(true)}>
          Merge into {run.baseBranch}
        </button>
      ) : (
        <div role="alertdialog" aria-label="Confirm merge" className="pipeline__confirm">
          <p>
            Fast-forward <code>{run.baseBranch}</code> to <code>{run.integrationBranch}</code>, commit{' '}
            <code>docs/plans/{run.planFile}</code> if it is not committed yet, then remove the run&apos;s worktrees and
            branches. Nothing is pushed.
          </p>
          <div className="pipeline__actions">
            <button type="button" className="pipeline__btn" disabled={merging} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="pipeline__btn pipeline__btn--primary" disabled={merging} onClick={() => void merge()}>
              {merging ? 'Merging...' : `Merge into ${run.baseBranch}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function MergedBanner({ info, baseBranch, onClose }: { info: MergedInfo; baseBranch: string; onClose: () => void }) {
  return (
    <div className="pipeline__finished" role="status" aria-label="Merged">
      <p>
        <strong>Merged into {baseBranch}</strong> at <code>{info.head}</code>
        {info.planCommitted ? ', plan committed' : ''}. The code is now in your project folder. Nothing was pushed.
      </p>
      {!info.cleanedUp && (
        <p className="pipeline__muted">
          The run&apos;s worktrees could not all be removed; use Discard on the run to clean them up.
        </p>
      )}
      <button type="button" className="pipeline__btn" onClick={onClose}>
        Dismiss
      </button>
    </div>
  )
}
