import { useId, useState } from 'react'
import {
  BRANCH_NAME_PATTERN,
  RESERVED_BRANCH_PREFIXES,
  featureBranchName,
  type PipelineBranchResult,
  type PipelineMergeResult,
  type PipelineRunView
} from '@shared/ipc'

const MERGE_ERRORS: Record<string, string> = {
  'not-found': 'The run was not found.',
  'not-finished': 'The run is not finished.',
  'base-protected': 'Merging into the base branch is off for this project.',
  'wrong-branch': 'The project is not on the base branch.',
  dirty: 'The project has uncommitted changes.',
  'not-fast-forward': 'The base branch moved since the run started.',
  'git-failed': 'Git could not merge the run.'
}

const BRANCH_ERRORS: Record<string, string> = {
  'not-found': 'The run was not found.',
  'not-finished': 'The run is not finished.',
  'invalid-branch': 'That is not a valid branch name.',
  'reserved-branch': 'run/ and task/ branches belong to the pipeline; pick another name.',
  'base-protected': 'That is the base branch; pick a feature branch name.',
  dirty: 'That branch is checked out with uncommitted changes.',
  'not-fast-forward': 'That branch has commits this run does not have; pick a new name.',
  'git-failed': 'Git could not save the branch.'
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

/** What happened to a finished run: merged into its base branch, or saved as a branch. */
export type DoneInfo =
  | (Extract<PipelineMergeResult, { ok: true }> & { kind: 'merge'; runId: string; integrationBranch: string })
  | (Extract<PipelineBranchResult, { ok: true }> & { kind: 'branch'; runId: string; integrationBranch: string })

/** Checks a typed branch name before asking the main process; null when it looks fine. */
export function branchProblem(name: string, baseBranch: string): string | null {
  const n = name.trim()
  if (n === '') return 'Enter a branch name.'
  if (!BRANCH_NAME_PATTERN.test(n)) return 'Use letters, digits, ".", "_", "-" and "/" (for example feature/api-contracts).'
  if (RESERVED_BRANCH_PREFIXES.some((p) => n.startsWith(p))) return BRANCH_ERRORS['reserved-branch'] ?? null
  if (n === baseBranch) return `${baseBranch} is the base branch; pick a feature branch name.`
  return null
}

/** The end of a successful run: what was built, and where the user wants it (a branch, a PR, or the base branch). */
export function RunFinished({ projectId, run, onDone }: { projectId: string; run: PipelineRunView; onDone: (info: DoneInfo) => void }) {
  const id = useId()
  const [confirming, setConfirming] = useState<'branch' | 'merge' | 'pr' | null>(null)
  const [branch, setBranch] = useState(() => featureBranchName(run.planFile))
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
  const autoSettled = delivery?.status === 'done' && (delivery.policy === 'merge-local' || delivery.policy === 'save-branch')
  const allowMerge = run.allowBaseMerge === true
  const problem = branchProblem(branch, run.baseBranch)

  async function act<T extends { ok: boolean; error?: string; message?: string }>(
    call: () => Promise<T>,
    errors: Record<string, string>,
    fallback: string,
    onOk: (r: T) => void
  ) {
    setWorking(true)
    setError(null)
    try {
      const r = await call()
      if (r.ok) onOk(r)
      else setError(r.message ?? (r.error ? errors[r.error] : undefined) ?? fallback)
    } catch {
      setError(fallback)
    } finally {
      setWorking(false)
      setConfirming(null)
    }
  }

  const saveBranch = () =>
    act(
      () => window.api.pipelineBranch({ projectId, runId: run.runId, branch: branch.trim() }),
      BRANCH_ERRORS,
      'Could not save the branch.',
      (r) => {
        if (r.ok) onDone({ ...r, kind: 'branch', runId: run.runId, integrationBranch: run.integrationBranch })
      }
    )

  const merge = () =>
    act(
      () => window.api.pipelineMerge({ projectId, runId: run.runId }),
      MERGE_ERRORS,
      'Could not merge the run.',
      (r) => {
        if (r.ok) onDone({ ...r, kind: 'merge', runId: run.runId, integrationBranch: run.integrationBranch })
      }
    )

  const openPr = () =>
    act(
      () => window.api.pipelinePr({ projectId, runId: run.runId }),
      PR_ERRORS,
      'Could not open the pull request.',
      (r) => {
        if (!r.ok) return
        const opened = { url: r.url, branch: r.branch, host: r.host }
        openedPrs.set(run.runId, opened)
        setPr(opened)
        void window.api.openUrl({ url: r.url }).catch(() => false)
      }
    )

  const prWord = pr?.host === 'gitlab' ? 'merge request' : 'pull request'
  return (
    <div className="pipeline__finished" role="region" aria-label="Run finished">
      <p>
        <strong>Run finished.</strong> {done} of {run.tasks.length} {run.tasks.length === 1 ? 'task' : 'tasks'} built and
        merged into <code>{run.integrationBranch}</code>
        {reviewed ? ` · review: ${blocking} blocking, ${minor} minor` : ' · not reviewed'}.
      </p>
      <p className="pipeline__muted">
        The work is only on the run branch for now. Save it as a feature branch to keep it
        {allowMerge ? <>, or merge it into <code>{run.baseBranch}</code></> : null}; your checked-out branch is not touched.
      </p>
      {autoBusy && (
        <p role="status">
          {delivery?.policy === 'open-pr'
            ? 'Opening the pull request automatically…'
            : delivery?.policy === 'save-branch'
              ? 'Saving the result as a feature branch automatically…'
              : 'Merging into the local project automatically…'}
        </p>
      )}
      {delivery?.status === 'failed' && (
        <p role="alert" className="pipeline__error">
          Automatic action failed: {delivery.message ?? 'Try the action manually.'}
        </p>
      )}
      {delivery?.policy === 'merge-local' && delivery.status === 'done' && <p role="status">Merged into the local project.</p>}
      {delivery?.policy === 'save-branch' && delivery.status === 'done' && (
        <p role="status">
          Saved as branch <code>{delivery.branch ?? 'feature branch'}</code>.
        </p>
      )}
      {autoPrUrl && (
        <p role="status">
          Opened pull request:{' '}
          <a
            href={autoPrUrl}
            onClick={(e) => {
              e.preventDefault()
              void window.api.openUrl({ url: autoPrUrl }).catch(() => false)
            }}
          >
            {autoPrUrl}
          </a>
        </p>
      )}
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
      {confirming === null && !autoBusy && !autoSettled && (
        <div className="pipeline__actions">
          <button type="button" className="pipeline__btn pipeline__btn--primary" onClick={() => setConfirming('branch')}>
            Save as branch…
          </button>
          {!pr && !autoPrUrl && (
            <button type="button" className="pipeline__btn" onClick={() => setConfirming('pr')}>
              Open pull request
            </button>
          )}
          {allowMerge && (
            <button type="button" className="pipeline__btn" onClick={() => setConfirming('merge')}>
              Merge into {run.baseBranch}
            </button>
          )}
        </div>
      )}
      {confirming === 'branch' && (
        <form
          role="alertdialog"
          aria-label="Save as branch"
          className="pipeline__confirm"
          onSubmit={(e) => {
            e.preventDefault()
            if (problem === null && !working) void saveBranch()
          }}
        >
          <label className="pipeline__field" htmlFor={`${id}-branch`}>
            Branch name
          </label>
          <input
            id={`${id}-branch`}
            className="pipeline__input"
            value={branch}
            autoFocus
            spellCheck={false}
            aria-invalid={problem !== null}
            aria-describedby={`${id}-branch-help`}
            onChange={(e) => setBranch(e.target.value)}
          />
          <p id={`${id}-branch-help`} className={problem ? 'pipeline__error' : 'pipeline__muted'}>
            {problem ??
              'A new branch is created from the run. An existing branch is only fast-forwarded, and only when it has nothing the run lacks.'}
          </p>
          <p>
            Your checked-out branch (<code>{run.baseBranch}</code>) stays as it is and nothing is pushed. The run&apos;s{' '}
            <code>run/</code> and <code>task/</code> branches and worktrees are removed afterwards. The plan file stays in
            your folder, uncommitted.
          </p>
          <div className="pipeline__actions">
            <button type="button" className="pipeline__btn" disabled={working} onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="submit" className="pipeline__btn pipeline__btn--primary" disabled={working || problem !== null}>
              {working ? 'Saving...' : 'Save branch'}
            </button>
          </div>
        </form>
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

export function DoneBanner({ info, onClose }: { info: DoneInfo; onClose: () => void }) {
  return (
    <div className="pipeline__finished" role="status" aria-label={info.kind === 'merge' ? 'Merged' : 'Saved as branch'}>
      {info.kind === 'merge' ? (
        <p>
          <strong>Merged into {info.baseBranch}</strong> at <code>{info.head}</code>
          {info.planCommitted ? ', plan committed' : ''}. The code is now in your project folder. Nothing was pushed.
        </p>
      ) : (
        <p>
          <strong>
            {info.created ? 'Saved as new branch' : 'Updated branch'} {info.branch}
          </strong>{' '}
          at <code>{info.head}</code>. Nothing was pushed. Switch to it with <code>git switch {info.branch}</code> when your
          work tree is ready, or push it and open a pull request from there.
        </p>
      )}
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
