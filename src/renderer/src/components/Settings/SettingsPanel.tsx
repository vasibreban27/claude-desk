import { useEffect, useId, useState, type FormEvent } from 'react'
import { CHECKS_MAX_COUNT, projectSettingsSchema, type AppInfo, type CheckConfig, type DeliveryChoice, type ModelChoice, type ProjectSettings } from '@shared/ipc'
import { useSettings, type SaveError } from '../../hooks/useSettings'
import { ChecksEditor, newRow, rowsFromChecks, validateRows, type CheckRow, type RowErrors } from './ChecksEditor'
import {
  LimitsEditor,
  limitsFromSettings,
  validateLimits,
  type LimitErrors,
  type LimitValues
} from './LimitsEditor'
import { ReviewEditor, reviewFromSettings, validateReview, type ReviewValues } from './ReviewEditor'
import { McpConnections } from './McpConnections'
import './settings.css'

const MODEL_LABELS: Record<ModelChoice, string> = {
  auto: 'Use app default',
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus'
}

const SAVE_ERRORS: Record<SaveError | 'client-invalid', string> = {
  invalid: 'The settings were rejected as invalid. Check the protected paths (at most 100 lines, 200 characters each).',
  'client-invalid':
    'The settings are invalid. Check the protected paths (at most 100 lines, 200 characters each).',
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

interface FormProps {
  projectId: string
  initial: ProjectSettings
  saving: boolean
  saveError: SaveError | null
  saveOk: boolean
  sessionReset: boolean
  onSave: (settings: ProjectSettings) => void
  onEdit: () => void
}

function SettingsForm({ projectId, initial, saving, saveError, saveOk, sessionReset, onSave, onEdit }: FormProps) {
  const id = useId()
  const [model, setModel] = useState<ModelChoice>(initial.model)
  const [paths, setPaths] = useState(initial.protectedPaths.join('\n'))
  const [allowGitRead, setAllowGitRead] = useState(initial.allowGitRead)
  const [allowPlanWrites, setAllowPlanWrites] = useState(initial.allowPlanWrites)
  const [allowCommands, setAllowCommands] = useState(initial.allowCommands ?? false)
  const [delivery, setDelivery] = useState<DeliveryChoice>(initial.delivery ?? 'manual')
  const [rows, setRows] = useState<CheckRow[]>(() => rowsFromChecks(initial.checks))
  const [suggestions, setSuggestions] = useState<CheckConfig[]>([])
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

  function submit(ev: FormEvent) {
    ev.preventDefault()
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
      checks: validation.errors.size === 0 ? validation.checks : undefined,
      ...(limitsOk ? limitValidation.values : {}),
      ...(reviewOk ? reviewValidation.values : {})
    })
    setClientInvalid(!parsed.success)
    if (parsed.success && validation.errors.size === 0 && limitsOk && reviewOk) onSave(parsed.data)
  }

  const errorText = clientInvalid ? SAVE_ERRORS['client-invalid'] : saveError ? SAVE_ERRORS[saveError] : null
  const showSaved = saveOk && !saving && !clientInvalid

  return (
    <form className="settings__section" onSubmit={submit} aria-label="Project settings">
      <h3 className="settings__heading">Project</h3>
      <div className="settings__field">
        <label htmlFor={`${id}-model`}>Model</label>
        <select id={`${id}-model`} value={model} onChange={(e) => {
            setModel(e.target.value as ModelChoice)
            onEdit()
          }}>
          {(Object.keys(MODEL_LABELS) as ModelChoice[]).map((m) => (
            <option key={m} value={m}>
              {MODEL_LABELS[m]}
            </option>
          ))}
        </select>
        <p className="settings__hint">
          Use the app default, or choose a different model for Chat and tasks without a model in the plan.
        </p>
      </div>
      <div className="settings__field">
        <label htmlFor={`${id}-paths`}>Protected paths</label>
        <textarea
          id={`${id}-paths`}
          value={paths}
          spellCheck={false}
          aria-describedby={`${id}-paths-hint`}
          onChange={(e) => {
            setPaths(e.target.value)
            onEdit()
          }}
        />
        <p id={`${id}-paths-hint`} className="settings__hint">
          One gitignore-style pattern per line; an empty list protects nothing. {BEST_EFFORT_NOTE}
        </p>
      </div>
      <div className="settings__field">
        <label className="settings__toggle">
          <input type="checkbox" checked={allowGitRead} onChange={(e) => {
              setAllowGitRead(e.target.checked)
              onEdit()
            }} />
          Allow read-only git
        </label>
        <p className="settings__hint">Adds git status, log and diff tools; no shell access.</p>
      </div>
      <div className="settings__field">
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={allowPlanWrites}
            onChange={(e) => {
              setAllowPlanWrites(e.target.checked)
              onEdit()
            }}
          />
          Allow plan writes
        </label>
        <p className="settings__hint">Chat may edit docs/plans/*.md. Plan mode can already edit plans.</p>
      </div>
      <div className="settings__field">
        <label className="settings__toggle">
          <input type="checkbox" checked={allowCommands} onChange={(e) => { setAllowCommands(e.target.checked); onEdit() }} />
          Let workers run setup commands
        </label>
        <p className="settings__hint">Workers may run supported setup commands inside their worktree.</p>
      </div>
      <div className="settings__field">
        <label htmlFor={`${id}-delivery`}>After a successful run</label>
        <select id={`${id}-delivery`} value={delivery} onChange={(e) => { setDelivery(e.target.value as DeliveryChoice); onEdit() }}>
          <option value="manual">Keep local for my decision</option>
          <option value="open-pr">Push run branch and open a PR</option>
          <option value="merge-local">Merge into my local project</option>
        </select>
        <p className="settings__hint">Automatic actions run only after every task succeeds; manual is the default.</p>
      </div>
      <LimitsEditor
        values={limits}
        errors={limitErrors}
        onChange={(next) => {
          setLimits(next)
          onEdit()
        }}
      />
      <ReviewEditor
        values={review}
        error={reviewError}
        onChange={(next) => {
          setReview(next)
          onEdit()
        }}
      />
      {suggestions.filter((check) => !rows.some((row) => row.executable === check.executable && row.args === check.args.join('\n'))).length > 0 ? (
        <section className="settings__section" aria-label="Suggested checks">
          <h3 className="settings__heading">Suggested checks</h3>
          <p className="settings__hint">Found from files in this project. Add one, then save Project settings to use it.</p>
          {suggestions.filter((check) => !rows.some((row) => row.executable === check.executable && row.args === check.args.join('\n'))).map((check) => (
            <div key={check.name} className="settings__field">
              <code>{[check.executable, ...check.args].join(' ')}</code>{' '}
              <button type="button" className="settings__small-button" disabled={rows.length >= CHECKS_MAX_COUNT} onClick={() => {
                setRows((current) => [...current, newRow({ name: check.name, executable: check.executable, args: check.args.join('\n'), timeoutSec: String(check.timeoutMs / 1000) })])
                onEdit()
              }}>Add check</button>
            </div>
          ))}
        </section>
      ) : null}
      <ChecksEditor
        rows={rows}
        errors={checkErrors}
        onChange={(next) => {
          setRows(next)
          onEdit()
        }}
      />
      {checkErrors.size > 0 ? (
        <p role="alert" className="settings__message">
          Some checks are invalid. Fix the marked fields and save again.
        </p>
      ) : null}
      <button type="submit" className="settings__save" disabled={saving || reviewError !== null}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {errorText ? (
        <p role="alert" className="settings__message">
          {errorText}
        </p>
      ) : null}
      {showSaved ? (
        <p role="status" className="settings__message">
          Settings saved. They apply to the next message or run.
        </p>
      ) : null}
      {showSaved && sessionReset ? (
        <p role="status" className="settings__message">
          The next message starts a new session and loses conversation context.
        </p>
      ) : null}
    </form>
  )
}

export interface SettingsPanelProps {
  projectId: string | null
}

function AppBasics({ info, error }: { info: AppInfo | null; error: boolean }) {
  const id = useId()
  const [root, setRoot] = useState<string | null>(null)
  const [model, setModel] = useState<ModelChoice>('auto')
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    void window.api?.projectsRootGet?.().then((r) => { if (live) setRoot(r.root) }).catch(() => undefined)
    void window.api?.appModelGet?.().then((r) => { if (live) setModel(r.model) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const toolkit = info?.toolkit
  const toolkitStatus = toolkit?.status === 'valid' ? 'Valid' : toolkit?.status === 'invalid' ? 'Invalid' : 'Not set'
  async function saveModel() {
    setSaving(true)
    setMessage(null)
    try {
      const r = await window.api.appModelSet({ model })
      setMessage(r.ok ? 'App default model saved.' : 'Could not save the app model.')
    } catch {
      setMessage('Could not save the app model.')
    } finally {
      setSaving(false)
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
      <div className="settings__field">
        <label htmlFor={`${id}-app-model`}>Default model</label>
        <select id={`${id}-app-model`} value={model} onChange={(e) => setModel(e.target.value as ModelChoice)}>
          <option value="auto">Auto</option><option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option><option value="opus">Opus</option>
        </select>
        <p className="settings__hint">Used by Chat and pipeline tasks unless a project or plan task chooses another model.</p>
        <button type="button" className="settings__small-button" disabled={saving} onClick={() => void saveModel()}>{saving ? 'Saving...' : 'Save default model'}</button>
      </div>
      <div className="settings__field">
        <strong>Projects folder</strong>
        <p className="settings__path">{root ?? 'Not set'}</p>
        <p className="settings__hint">New projects are created inside this folder; existing projects stay where they are.</p>
        <button type="button" className="settings__small-button" onClick={() => void pickRoot()}>Choose folder…</button>
      </div>
      <div className="settings__field">
        <strong>Toolkit</strong>
        <p className="settings__hint">The shared agents and skills used for new sessions and pipeline runs.</p>
        {error ? <p role="alert">Could not load app information.</p> : toolkit ? (
          <dl><dt>Path</dt><dd className="settings__path">{toolkit.path ?? 'Not set'}</dd>
            <dt>Status</dt><dd>{toolkitStatus}</dd>
            {toolkit.version ? <><dt>Plugin version</dt><dd>{toolkit.version}</dd></> : null}</dl>
        ) : <p role="status">Loading app information...</p>}
      </div>
      {message ? <p role="status" className="settings__message">{message}</p> : null}
    </section>
  )
}

export function SettingsPanel({ projectId }: SettingsPanelProps) {
  const s = useSettings(projectId)

  return (
    <div className="settings">
      <div className="settings__group">
        <AppBasics info={s.appInfo} error={s.appInfoError} />
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
          key={`${projectId}:${s.revision}`}
          projectId={projectId}
          initial={s.settings}
          saving={s.saving}
          saveError={s.saveError}
          saveOk={s.saveOk}
          sessionReset={s.sessionReset}
          onSave={(next) => void s.save(next)}
          onEdit={s.clearSaveState}
        />
      ) : null}
    </div>
  )
}
