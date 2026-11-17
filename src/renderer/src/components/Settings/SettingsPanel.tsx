import { useId, useState, type FormEvent } from 'react'
import { projectSettingsSchema, type ModelChoice, type ProjectSettings } from '@shared/ipc'
import { useSettings, type SaveError } from '../../hooks/useSettings'
import './settings.css'

const MODEL_LABELS: Record<ModelChoice, string> = {
  auto: 'Auto',
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
  initial: ProjectSettings
  saving: boolean
  saveError: SaveError | null
  saveOk: boolean
  sessionReset: boolean
  onSave: (settings: ProjectSettings) => void
  onEdit: () => void
}

function SettingsForm({ initial, saving, saveError, saveOk, sessionReset, onSave, onEdit }: FormProps) {
  const id = useId()
  const [model, setModel] = useState<ModelChoice>(initial.model)
  const [paths, setPaths] = useState(initial.protectedPaths.join('\n'))
  const [allowGitRead, setAllowGitRead] = useState(initial.allowGitRead)
  const [allowPlanWrites, setAllowPlanWrites] = useState(initial.allowPlanWrites)
  const [clientInvalid, setClientInvalid] = useState(false)

  function submit(ev: FormEvent) {
    ev.preventDefault()
    if (saving) return
    const parsed = projectSettingsSchema.safeParse({
      version: 1,
      model,
      protectedPaths: parsePaths(paths),
      allowGitRead,
      allowPlanWrites
    })
    setClientInvalid(!parsed.success)
    if (parsed.success) onSave(parsed.data)
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
        <p className="settings__hint">Applies to the main chat. Toolkit agents keep their own model.</p>
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
        <p className="settings__hint">Lets the chat write files named docs/plans/&lt;slug&gt;.md, nothing else.</p>
      </div>
      <button type="submit" className="settings__save" disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {errorText ? (
        <p role="alert" className="settings__message">
          {errorText}
        </p>
      ) : null}
      {showSaved ? (
        <p role="status" className="settings__message">
          Settings saved. They apply to the next message.
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

export function SettingsPanel({ projectId }: SettingsPanelProps) {
  const s = useSettings(projectId)

  if (projectId === null) {
    return <p className="settings__empty">Select a project to edit its settings.</p>
  }

  const toolkit = s.appInfo?.toolkit
  const toolkitStatus =
    toolkit?.status === 'valid' ? 'Valid' : toolkit?.status === 'invalid' ? 'Invalid' : 'Not set'

  return (
    <div className="settings">
      {s.loading ? <p role="status">Loading settings...</p> : null}
      {s.loadError ? <p role="alert">{s.loadError}</p> : null}
      {s.notice ? (
        <p role="status" className="settings__banner">
          {s.notice === 'storage-unavailable'
            ? 'Settings storage is unavailable. Safe defaults are in use.'
            : 'Stored settings were unreadable. Safe defaults are in use until you save.'}
        </p>
      ) : null}
      {s.settings ? (
        <SettingsForm
          key={`${projectId}:${s.revision}`}
          initial={s.settings}
          saving={s.saving}
          saveError={s.saveError}
          saveOk={s.saveOk}
          sessionReset={s.sessionReset}
          onSave={(next) => void s.save(next)}
          onEdit={s.clearSaveState}
        />
      ) : null}
      <section className="settings__section" aria-label="App">
        <h3 className="settings__heading">App</h3>
        {s.appInfoError ? (
          <p role="alert">Could not load app information.</p>
        ) : toolkit ? (
          <dl>
            <dt>Toolkit path</dt>
            <dd className="settings__path">{toolkit.path ?? 'Not set'}</dd>
            <dt>Status</dt>
            <dd>{toolkitStatus}</dd>
            {toolkit.version ? (
              <>
                <dt>Plugin version</dt>
                <dd>{toolkit.version}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p role="status">Loading app information...</p>
        )}
      </section>
    </div>
  )
}
