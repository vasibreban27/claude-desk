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

const PR_ERRORS: Record<string, string> = {
  'not-found': 'The run was not found.',
  'not-finished': 'The run is not finished.',
  'no-remote': 'The project has no origin remote.',
  'unsupported-host': 'Only GitHub and GitLab remotes are supported.',
  'no-cli': 'gh / glab was not found.',
  'not-logged-in': 'gh / glab is not logged in.',
  'base-not-on-remote': 'The base branch is not on origin yet.',
  'push-failed': 'git push failed.',
  'pr-failed': 'Could not open the pull request.'
}

interface OpenedPr {
  url: string
  branch: string
  host: 'github' | 'gitlab'
}
/** Survives remounts of the panel while the app runs. */
const openedPrs = new Map<string, OpenedPr>()

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
  const [confirming, setConfirming] = useState<'merge' | 'pr' | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pr, setPr] = useState<OpenedPr | null>(() => openedPrs.get(run.runId) ?? null)
  const done = run.tasks.filter((t) => t.status === 'done').length
  const blocking = run.tasks.reduce((n, t) => n + (t.findings?.blocking ?? 0), 0)
  const minor = run.tasks.reduce((n, t) => n + (t.findings?.minor ?? 0), 0)
  const reviewed = run.tasks.some((t) => t.findings !== null)
  const delivery = run.delivery
  const autoBusy = delivery?.status === 'pending' || delivery?.status === 'working'
  const autoPrUrl = delivery?.policy === 'open-pr' && delivery.status === 'done' ? delivery.url : undefined

  async function merge() {
    setWorking(true)
    setError(null)
    try {
      const r = await window.api.pipelineMerge({ projectId, runId: run.runId })
      if (r.ok) onMerged({ ...r, runId: run.runId, integrationBranch: run.integrationBranch })
      else setError(r.message ?? MERGE_ERRORS[r.error] ?? 'Could not merge the run.')
    } catch {
      setError('Could not merge the run.')
    } finally {
      setWorking(false)
      setConfirming(null)
    }
  }

  async function openPr() {
    setWorking(true)
    setError(null)
    try {
      const r = await window.api.pipelinePr({ projectId, runId: run.runId })
      if (r.ok) {
        const opened = { url: r.url, branch: r.branch, host: r.host }
        openedPrs.set(run.runId, opened)
        setPr(opened)
        void window.api.openUrl({ url: r.url }).catch(() => false)
      } else setError(r.message ?? PR_ERRORS[r.error] ?? 'Could not open the pull request.')
    } catch {
      setError('Could not open the pull request.')
    } finally {
      setWorking(false)
      setConfirming(null)
    }
  }

  const prWord = pr?.host === 'gitlab' ? 'merge request' : 'pull request'
  return (
    <div className="pipeline__finished" role="region" aria-label="Run finished">
      <p>
        <strong>Run finished.</strong> {done} of {run.tasks.length} {run.tasks.length === 1 ? 'task' : 'tasks'} built and
        merged into <code>{run.integrationBranch}</code>
        {reviewed ? ` · review: ${blocking} blocking, ${minor} minor` : ' · not reviewed'}.
      </p>
      <p className="pipeline__muted">
        Your project folder still shows <code>{run.baseBranch}</code> without this work until you merge it here or
        through a pull request.
      </p>
      {autoBusy && <p role="status">{delivery?.policy === 'open-pr' ? 'Opening the pull request automatically…' : 'Merging into the local project automatically…'}</p>}
      {delivery?.status === 'failed' && <p role="alert" className="pipeline__error">Automatic action failed: {delivery.message ?? 'Try the action manually.'}</p>}
      {delivery?.policy === 'merge-local' && delivery.status === 'done' && <p role="status">Merged into the local project.</p>}
      {autoPrUrl && <p role="status">Opened pull request: <a href={autoPrUrl} onClick={(e) => { e.preventDefault(); void window.api.openUrl({ url: autoPrUrl }).catch(() => false) }}>{autoPrUrl}</a></p>}
      {pr && (
        <p role="status" aria-label="Pull request">
          Opened {prWord} from <code>{pr.branch}</code>:{' '}
          <a
            href={pr.url}
            onClick={(e) => {
              e.preventDefault()
              void window.api.openUrl({ url: pr.url }).catch(() => false)
            }}
          >
            {pr.url}
          </a>
        </p>
      )}
      {error && (
        <p role="alert" className="pipeline__error">
          {error}
        </p>
      )}
      {confirming === null && !autoBusy && !(delivery?.policy === 'merge-local' && delivery.status === 'done') && (
        <div className="pipeline__actions">
          <button type="button" className="pipeline__btn pipeline__btn--primary" onClick={() => setConfirming('merge')}>
            Merge into {run.baseBranch}
          </button>
          {!pr && !autoPrUrl && (
            <button type="button" className="pipeline__btn" onClick={() => setConfirming('pr')}>
              Open pull request
            </button>
          )}
        </div>
      )}
      {confirming === 'merge' && (
        <div role="alertdialog" aria-label="Confirm merge" className="pipeline__confirm">
          <p>
            Fast-forward <code>{run.baseBranch}</code> to <code>{run.integrationBranch}</code>, commit{' '}
            <code>docs/plans/{run.planFile}</code> if it is not committed yet, then remove the run&apos;s worktrees and
            branches. Nothing is pushed.
          </p>
          <div className="pipeline__actions">
            <button type="button" className="pipeline__btn" disabled={working} onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className="pipeline__btn pipeline__btn--primary" disabled={working} onClick={() => void merge()}>
              {working ? 'Merging...' : `Merge into ${run.baseBranch}`}
            </button>
          </div>
        </div>
      )}
      {confirming === 'pr' && (
        <div role="alertdialog" aria-label="Confirm pull request" className="pipeline__confirm">
          <p>
            Push <code>{run.integrationBranch}</code> to <code>origin</code> as a review branch and open a pull request
            into <code>{run.baseBranch}</code> with your <code>gh</code> (GitHub) or <code>glab</code> (GitLab) login.
            The plan file is added to it. Nothing is merged and <code>{run.baseBranch}</code> is not pushed.
          </p>
          <div className="pipeline__actions">
            <button type="button" className="pipeline__btn" disabled={working} onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className="pipeline__btn pipeline__btn--primary" disabled={working} onClick={() => void openPr()}>
              {working ? 'Pushing...' : 'Push and open pull request'}
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
