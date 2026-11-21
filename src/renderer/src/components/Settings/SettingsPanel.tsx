import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  CHECKS_MAX_COUNT,
  projectSettingsSchema,
  type CheckConfig,
  type DeliveryChoice,
  type ModelChoice,
  type ProjectSettings,
  type ToolkitStatus
} from '@shared/ipc'
import { useSettings, type SaveError } from '../../hooks/useSettings'
import { ChecksEditor, newRow, rowsFromChecks, validateRows, type CheckRow, type RowErrors } from './ChecksEditor'
import { LimitsEditor, limitsFromSettings, validateLimits, type LimitErrors, type LimitValues } from './LimitsEditor'
import { ReviewEditor, reviewFromSettings, validateReview, type ReviewValues } from './ReviewEditor'
import { McpConnections } from './McpConnections'
import { CHECK_PRESETS, commandOf, presetGroups } from './checkPresets'
import './settings.css'

const MODEL_LABELS: Record<ModelChoice, string> = {
  auto: 'Use app default',
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus'
}
const MODEL_NAME: Record<Exclude<ModelChoice, 'auto'>, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const DELIVERY_LABELS: Record<DeliveryChoice, string> = {
  manual: 'Keep local for my decision',
  'save-branch': 'Save as a feature branch',
  'open-pr': 'Push run branch and open a PR',
  'merge-local': 'Merge into the base branch'
}

const SAVE_ERRORS: Record<SaveError | 'client-invalid', string> = {
  invalid: 'The settings were rejected as invalid. Check the protected paths (at most 100 lines, 200 characters each).',
  'client-invalid':
    'The settings are invalid. Check the marked fields and the protected paths (at most 100 lines, 200 characters each).',
  'not-found': 'This project no longer exists.',
  'storage-unavailable': 'Settings could not be saved: storage is unavailable.',
  unavailable: 'Settings could not be saved: the desktop bridge is unavailable.'
}

export const BEST_EFFORT_NOTE =
  'Protected paths block Read and direct access. Search tools are best-effort: Grep excludes matching files, but Glob can still list their names.'

function parsePaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
}

/** What the effective model is for Chat and for pipeline tasks whose agent and plan task pick none. */
export function effectiveModelText(project: ModelChoice, app: ModelChoice): string {
  if (project !== 'auto') return `${MODEL_NAME[project]} (set for this project)`
  if (app !== 'auto') return `${MODEL_NAME[app]} (the app default)`
  return "Claude Code's default (neither the project nor the app picks one)"
}

/** A collapsible group of settings with a one-line summary of its current values. */
function Card({ title, summary, open = false, children }: { title: string; summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="settings__card" open={open}>
      <summary className="settings__card-head">
        <span className="settings__card-title">{title}</span>
        <span className="settings__card-summary">{summary}</span>
      </summary>
      <div className="settings__card-body">{children}</div>
    </details>
  )
}

interface FormProps {
  projectId: string
  initial: ProjectSettings
  appModel: ModelChoice
  saving: boolean
  saveError: SaveError | null
  saveOk: boolean
  sessionReset: boolean
  onSave: (settings: ProjectSettings) => void
  onEdit: () => void
  onDiscard: () => void
  onOpenToolkit?: (() => void) | undefined
}

function SettingsForm({
  projectId,
  initial,
  appModel,
  saving,
  saveError,
  saveOk,
  sessionReset,
  onSave,
  onEdit,
  onDiscard,
  onOpenToolkit
}: FormProps) {
  const id = useId()
  const [model, setModel] = useState<ModelChoice>(initial.model)
  const [paths, setPaths] = useState(initial.protectedPaths.join('\n'))
  const [allowGitRead, setAllowGitRead] = useState(initial.allowGitRead)
  const [allowPlanWrites, setAllowPlanWrites] = useState(initial.allowPlanWrites)
  const [allowCommands, setAllowCommands] = useState(initial.allowCommands ?? false)
  const [delivery, setDelivery] = useState<DeliveryChoice>(initial.delivery ?? 'manual')
  const [allowBaseMerge, setAllowBaseMerge] = useState(initial.allowBaseMerge ?? false)
  const [rows, setRows] = useState<CheckRow[]>(() => rowsFromChecks(initial.checks))
  const [suggestions, setSuggestions] = useState<CheckConfig[]>([])
  const [preset, setPreset] = useState('')
  useEffect(() => {
    let live = true
    void window.api?.settingsSuggestions?.({ projectId }).then((found) => { if (live) setSuggestions(found) }).catch(() => undefined)
    return () => { live = false }
  }, [projectId])
  const [checkErrors, setCheckErrors] = useState<ReadonlyMap<number, RowErrors>>(new Map())
  const [clientInvalid, setClientInvalid] = useState(false)
  const [limits, setLimits] = useState<LimitValues>(() => limitsFromSettings(initial))
  const [limitErrors, setLimitErrors] = useState<LimitErrors>({})
  const [review, setReview] = useState<ReviewValues>(() => reviewFromSettings(initial))
  const reviewValidation = validateReview(review)
  const reviewError = reviewValidation.error

  /** Everything the form edits, to tell whether there are unsaved changes. */
  const snapshot = (): string =>
    JSON.stringify({
      model,
      paths,
      allowGitRead,
      allowPlanWrites,
      allowCommands,
      delivery,
      allowBaseMerge,
      rows: rows.map((r) => [r.name, r.executable, r.args, r.timeoutSec, r.acceptsTestPath]),
      limits,
      review
    })
  const [initialSnapshot] = useState(snapshot)
  const dirty = snapshot() !== initialSnapshot

  const edit = (apply: () => void) => {
    apply()
    onEdit()
  }

  const hasCheck = (c: CheckConfig): boolean => rows.some((r) => r.executable === c.executable && r.args === c.args.join('\n'))
  const addCheck = (c: CheckConfig) => {
    if (hasCheck(c) || rows.length >= CHECKS_MAX_COUNT) return
    edit(() =>
      setRows((current) => [
        ...current,
        newRow({
          name: rows.some((r) => r.name === c.name) ? `${c.name}-${current.length + 1}` : c.name,
          executable: c.executable,
          args: c.args.join('\n'),
          timeoutSec: String(c.timeoutMs / 1000),
          acceptsTestPath: c.acceptsTestPath === true
        })
      ])
    )
  }
  const found = suggestions.filter((c) => !hasCheck(c))

  function submit(ev?: FormEvent) {
    ev?.preventDefault()
    if (saving) return
    const validation = validateRows(rows)
    setCheckErrors(validation.errors)
    const limitValidation = validateLimits(limits)
    setLimitErrors(limitValidation.errors)
    const limitsOk = Object.keys(limitValidation.errors).length === 0
    const reviewOk = reviewValidation.error === null
    const parsed = projectSettingsSchema.safeParse({
      version: 1,
      model,
      protectedPaths: parsePaths(paths),
      allowGitRead,
      allowPlanWrites,
      allowCommands,
      delivery,
      allowBaseMerge,
      checks: validation.errors.size === 0 ? validation.checks : undefined,
      ...(limitsOk ? limitValidation.values : {}),
      ...(reviewOk ? reviewValidation.values : {})
    })
    setClientInvalid(!parsed.success)
    if (parsed.success && validation.errors.size === 0 && limitsOk && reviewOk) onSave(parsed.data)
  }

  const errorText = clientInvalid ? SAVE_ERRORS['client-invalid'] : saveError ? SAVE_ERRORS[saveError] : null
  const showSaved = saveOk && !saving && !clientInvalid && !dirty
  const reviewers = review.reviewers.length
  const protectedCount = parsePaths(paths).length

  return (
    <form className="settings__section settings__project" onSubmit={submit} aria-label="Project settings">
      <h3 className="settings__heading">Project</h3>

      <Card
        title="Quality"
        open
        summary={`${rows.length === 0 ? 'No checks' : `${rows.length} ${rows.length === 1 ? 'check' : 'checks'}`} · ${reviewers} ${reviewers === 1 ? 'reviewer' : 'reviewers'} · ${review.autoFixRounds} fix ${review.autoFixRounds === '1' ? 'round' : 'rounds'}`}
      >
        {rows.length === 0 && (
          <p role="status" className="settings__warning">
            No checks yet: tasks are reviewed but never tested, so broken code can be merged into the run. Add the
            project&apos;s test command below.
          </p>
        )}
        {found.length > 0 && (
          <section className="settings__section" aria-label="Suggested checks">
            <h4 className="settings__subheading">Found in this project</h4>
            {found.map((check) => (
              <div key={`${check.name}:${commandOf(check)}`} className="settings__preset">
                <code>{commandOf(check)}</code>
                <button type="button" className="settings__small-button" disabled={rows.length >= CHECKS_MAX_COUNT} onClick={() => addCheck(check)}>
                  Add check
                </button>
              </div>
            ))}
          </section>
        )}
        <div className="settings__field">
          <label htmlFor={`${id}-preset`}>Add a common check</label>
          <div className="settings__inline">
            <select id={`${id}-preset`} value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">Choose a check…</option>
              {presetGroups().map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.presets.map((p) => (
                    <option key={p.check.name} value={p.check.name} disabled={hasCheck(p.check)}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              className="settings__small-button"
              disabled={preset === '' || rows.length >= CHECKS_MAX_COUNT}
              onClick={() => {
                const p = CHECK_PRESETS.find((x) => x.check.name === preset)
                if (p) addCheck(p.check)
                setPreset('')
              }}
            >
              Add
            </button>
          </div>
          <p className="settings__hint">
            For example the test command: Maven projects use mvn -q test, Node projects npm test, Python projects pytest -q.
            Workers run checks by name before they commit, and the app runs them again before review. You can edit a check
            after adding it.
          </p>
        </div>
        <ChecksEditor rows={rows} errors={checkErrors} onChange={(next) => edit(() => setRows(next))} />
        {checkErrors.size > 0 ? (
          <p role="alert" className="settings__message">
            Some checks are invalid. Fix the marked fields and save again.
          </p>
        ) : null}
        <ReviewEditor values={review} error={reviewError} onChange={(next) => edit(() => setReview(next))} />
      </Card>

      <Card
        title="Pipeline"
        summary={`${limits.maxParallel} workers at once · ${limits.maxTurns} turns · ${limits.taskTimeoutMinutes} min per task · setup commands ${allowCommands ? 'on' : 'off'}`}
      >
        <LimitsEditor values={limits} errors={limitErrors} onChange={(next) => edit(() => setLimits(next))} />
        <div className="settings__field">
          <label className="settings__toggle">
            <input type="checkbox" checked={allowCommands} onChange={(e) => edit(() => setAllowCommands(e.target.checked))} />
            Let workers run setup commands
          </label>
          <p className="settings__hint">
            Workers may run allow-listed commands such as npm install or mvn inside their worktree (no git, no shell). Needed
            when a task adds a dependency.
          </p>
        </div>
      </Card>

      <Card title="After a run" summary={`${DELIVERY_LABELS[delivery]}${allowBaseMerge ? ' · base merges allowed' : ''}`}>
        <div className="settings__field">
          <label htmlFor={`${id}-delivery`}>After a successful run</label>
          <select id={`${id}-delivery`} value={delivery} onChange={(e) => edit(() => setDelivery(e.target.value as DeliveryChoice))}>
            {(Object.keys(DELIVERY_LABELS) as DeliveryChoice[]).map((d) => (
              <option key={d} value={d} disabled={d === 'merge-local' && !allowBaseMerge}>
                {DELIVERY_LABELS[d]}
              </option>
            ))}
          </select>
          <p className="settings__hint">
            Automatic actions run only after every task succeeds; manual is the default. A feature branch is named after the
            plan (feature/&lt;plan&gt;).
          </p>
        </div>
        <div className="settings__field">
          <label className="settings__toggle">
            <input
              type="checkbox"
              checked={allowBaseMerge}
              onChange={(e) =>
                edit(() => {
                  setAllowBaseMerge(e.target.checked)
                  if (!e.target.checked && delivery === 'merge-local') setDelivery('manual')
                })
              }
            />
            Allow merging runs into the base branch
          </label>
          <p className="settings__hint">
            Off: finished runs are saved as a feature branch or a pull request, never merged into the branch you started from
            (e.g. main). Turn on only for projects where you may commit to it directly.
          </p>
        </div>
      </Card>

      <Card title="Chat and models" summary={`Model: ${model === 'auto' ? 'app default' : MODEL_NAME[model]} · git read ${allowGitRead ? 'on' : 'off'}`}>
        <div className="settings__field">
          <label htmlFor={`${id}-model`}>Model</label>
          <select id={`${id}-model`} value={model} onChange={(e) => edit(() => setModel(e.target.value as ModelChoice))}>
            {(Object.keys(MODEL_LABELS) as ModelChoice[]).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
          <p className="settings__effective" role="note">
            Effective: {effectiveModelText(model, appModel)}
          </p>
          <p className="settings__hint">
            Used by Chat, and by pipeline tasks when neither the plan task nor its agent picks a model. Workers and reviewers
            can have their own model per project
            {onOpenToolkit ? (
              <>
                {' '}
                in the{' '}
                <button type="button" className="settings__link" onClick={onOpenToolkit}>
                  Toolkit tab
                </button>
              </>
            ) : (
              ' in the Toolkit tab'
            )}
            . Order: plan task, agent, this project, app default.
          </p>
        </div>
        <div className="settings__field">
          <label className="settings__toggle">
            <input type="checkbox" checked={allowGitRead} onChange={(e) => edit(() => setAllowGitRead(e.target.checked))} />
            Allow read-only git
          </label>
          <p className="settings__hint">Adds git status, log and diff tools to Chat and Plan; no shell access.</p>
        </div>
        <div className="settings__field">
          <label className="settings__toggle">
            <input type="checkbox" checked={allowPlanWrites} onChange={(e) => edit(() => setAllowPlanWrites(e.target.checked))} />
            Allow plan writes
          </label>
          <p className="settings__hint">Chat may edit docs/plans/*.md. Plan mode can already edit plans.</p>
        </div>
      </Card>

      <Card title="Safety" summary={`${protectedCount} protected ${protectedCount === 1 ? 'pattern' : 'patterns'}`}>
        <div className="settings__field">
          <label htmlFor={`${id}-paths`}>Protected paths</label>
          <textarea
            id={`${id}-paths`}
            value={paths}
            spellCheck={false}
            aria-describedby={`${id}-paths-hint`}
            onChange={(e) => edit(() => setPaths(e.target.value))}
          />
          <p id={`${id}-paths-hint`} className="settings__hint">
            One gitignore-style pattern per line; an empty list protects nothing. {BEST_EFFORT_NOTE}
          </p>
        </div>
      </Card>

      <div
        className={`settings__bar${dirty ? ' settings__bar--dirty' : ''}${errorText ? ' settings__bar--error' : ''}`}
        role="region"
        aria-label="Save project settings"
      >
        {errorText ? (
          <span className="settings__bar-text" role="alert">
            {errorText}
          </span>
        ) : showSaved ? (
          <span className="settings__bar-text" role="status">
            Settings saved. They apply to the next message or run.
            {sessionReset ? ' The next message starts a new session and loses conversation context.' : ''}
          </span>
        ) : (
          <span className="settings__bar-text">{saving ? 'Saving…' : dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}</span>
        )}
        {dirty && (
          <button type="button" className="settings__small-button" disabled={saving} onClick={onDiscard}>
            Discard
          </button>
        )}
        <button type="submit" className="settings__save" disabled={saving || reviewError !== null}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  )
}

const TOOLKIT_SOURCE: Record<ToolkitStatus['source'], string> = {
  settings: 'chosen here',
  environment: 'from CLAUDE_TOOLKIT_PATH',
  unset: 'not set'
}

function ToolkitFolder() {
  const [status, setStatus] = useState<ToolkitStatus | null>(null)
  const [busy, setBusy] = useState<'pick' | 'update' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // Without the desktop bridge there is nothing to load: show the error at once.
  const [failed, setFailed] = useState(() => typeof window.api?.toolkitStatus !== 'function')

  useEffect(() => {
    let live = true
    window.api
      ?.toolkitStatus?.()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  async function pick() {
    setBusy('pick')
    setMessage(null)
    try {
      const r = await window.api.toolkitPick()
      if (r.ok) {
        setStatus(r.status)
        setMessage({ kind: 'ok', text: 'Toolkit folder saved. New chats and runs use it.' })
      } else if (r.error !== 'cancelled') {
        setMessage({ kind: 'error', text: r.message ?? 'Could not use that folder.' })
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not choose the toolkit folder.' })
    } finally {
      setBusy(null)
    }
  }

  async function update() {
    setBusy('update')
    setMessage(null)
    try {
      const r = await window.api.toolkitUpdate()
      if (r.ok) {
        setMessage({ kind: 'ok', text: r.updated ? `Updated from ${r.from} to ${r.to}.` : 'Already up to date.' })
        setStatus(await window.api.toolkitStatus())
      } else {
        setMessage({ kind: 'error', text: r.message ?? 'Could not update the toolkit.' })
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not update the toolkit.' })
    } finally {
      setBusy(null)
    }
  }

  const valid = status?.status === 'valid'
  return (
    <section className="settings__field" aria-label="Toolkit folder">
      <strong>Toolkit</strong>
      <p className="settings__hint">The shared agents and skills (your claude-toolkit clone) used by Chat, Plan and pipeline runs.</p>
      {failed ? (
        <p role="alert">Could not load app information.</p>
      ) : status === null ? (
        <p role="status">Loading…</p>
      ) : (
        <dl className="settings__facts">
          <dt>Folder</dt>
          <dd className="settings__path">{status.path ?? 'Not set'}</dd>
          <dt>From</dt>
          <dd>{TOOLKIT_SOURCE[status.source]}</dd>
          <dt>Status</dt>
          <dd className={valid ? undefined : 'settings__error'}>{valid ? 'Valid' : status.status === 'invalid' ? 'Invalid' : 'Not set'}</dd>
          {status.version ? (
            <>
              <dt>Plugin version</dt>
              <dd>{status.version}</dd>
            </>
          ) : null}
          {status.git && (
            <>
              <dt>Git</dt>
              <dd>
                {status.git.branch ?? 'detached HEAD'} · {status.git.commit} · {status.git.date}
                {status.git.dirty ? ' · uncommitted changes' : ''}
                <span className="settings__hint"> — {status.git.subject}</span>
              </dd>
            </>
          )}
        </dl>
      )}
      {status !== null && !valid && (
        <p className="settings__hint">
          {status.status === 'invalid'
            ? 'That folder has no toolkit plugin. Choose your claude-toolkit clone.'
            : 'Choose your claude-toolkit clone; the app finds the plugin inside it.'}
        </p>
      )}
      <div className="settings__inline">
        <button type="button" className="settings__small-button" disabled={busy !== null} onClick={() => void pick()}>
          {busy === 'pick' ? 'Choosing…' : 'Choose folder…'}
        </button>
        {status?.git && (
          <button type="button" className="settings__small-button" disabled={busy !== null || status.git.dirty} onClick={() => void update()}>
            {busy === 'update' ? 'Updating…' : 'Update (git pull)'}
          </button>
        )}
      </div>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'settings__error' : 'settings__hint'}>
          {message.text}
        </p>
      )}
    </section>
  )
}

function AppBasics({ model, onModel }: { model: ModelChoice; onModel: (m: ModelChoice) => void }) {
  const id = useId()
  const [root, setRoot] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.api?.projectsRootGet?.().then((r) => { if (live) setRoot(r.root) }).catch(() => undefined)
    return () => { live = false }
  }, [])

  async function saveModel(next: ModelChoice) {
    const previous = model
    onModel(next)
    setMessage(null)
    try {
      const r = await window.api.appModelSet({ model: next })
      if (!r.ok) {
        onModel(previous)
        setMessage('Could not save the app model.')
      } else setMessage('Saved.')
    } catch {
      onModel(previous)
      setMessage('Could not save the app model.')
    }
  }
  async function pickRoot() {
    try {
      const r = await window.api.projectsRootPick()
      if (r.root !== null) setRoot(r.root)
    } catch {
      setMessage('Could not choose the projects folder.')
    }
  }
  return (
    <section className="settings__section" aria-label="App">
      <h3 className="settings__heading">App</h3>
      <p className="settings__hint">App settings are saved as soon as you change them.</p>
      <div className="settings__field">
        <label htmlFor={`${id}-app-model`}>Default model</label>
        <select id={`${id}-app-model`} value={model} onChange={(e) => void saveModel(e.target.value as ModelChoice)}>
          <option value="auto">Claude Code default</option>
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
        <p className="settings__hint">Used by Chat and pipeline tasks unless a project, agent or plan task chooses another model.</p>
      </div>
      <div className="settings__field">
        <strong>Projects folder</strong>
        <p className="settings__path">{root ?? 'Not set'}</p>
        <p className="settings__hint">New projects are created inside this folder; existing projects stay where they are.</p>
        <button type="button" className="settings__small-button" onClick={() => void pickRoot()}>
          Choose folder…
        </button>
      </div>
      <ToolkitFolder />
      {message ? (
        <p role="status" className="settings__hint">
          {message}
        </p>
      ) : null}
    </section>
  )
}

export interface SettingsPanelProps {
  projectId: string | null
  /** Opens the Toolkit tab (per-agent models and instructions). */
  onOpenToolkit?: () => void
}

export function SettingsPanel({ projectId, onOpenToolkit }: SettingsPanelProps) {
  const s = useSettings(projectId)
  const [appModel, setAppModel] = useState<ModelChoice>('auto')
  const [discards, setDiscards] = useState(0)
  useEffect(() => {
    let live = true
    void window.api?.appModelGet?.().then((r) => { if (live) setAppModel(r.model) }).catch(() => undefined)
    return () => { live = false }
  }, [])

  return (
    <div className="settings">
      <div className="settings__group">
        <AppBasics model={appModel} onModel={setAppModel} />
        <McpConnections />
      </div>
      {projectId === null ? <p className="settings__empty">Select a project to edit its project settings.</p> : null}
      {s.loading ? <p role="status">Loading settings...</p> : null}
      {s.loadError ? <p role="alert">{s.loadError}</p> : null}
      {s.notice ? (
        <p role="status" className="settings__banner">
          {s.notice === 'storage-unavailable'
            ? 'Settings storage is unavailable. Safe defaults are in use.'
            : 'Stored settings were unreadable. Safe defaults are in use until you save.'}
        </p>
      ) : null}
      {projectId !== null && s.settings ? (
        <SettingsForm
          key={`${projectId}:${s.revision}:${discards}`}
          projectId={projectId}
          initial={s.settings}
          appModel={appModel}
          saving={s.saving}
          saveError={s.saveError}
          saveOk={s.saveOk}
          sessionReset={s.sessionReset}
          onSave={(next) => void s.save(next)}
          onEdit={s.clearSaveState}
          onDiscard={() => {
            s.clearSaveState()
            setDiscards((n) => n + 1)
          }}
          onOpenToolkit={onOpenToolkit}
        />
      ) : null}
    </div>
  )
}
