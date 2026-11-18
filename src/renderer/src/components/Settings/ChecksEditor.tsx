import { useId } from 'react'
import { CHECKS_MAX_COUNT, checkSchema, type CheckConfig } from '@shared/ipc'

export type CheckField = 'name' | 'executable' | 'args' | 'timeout'

export interface CheckRow {
  key: number
  name: string
  executable: string
  /** One argument per line. */
  args: string
  /** Seconds, as typed. */
  timeoutSec: string
  acceptsTestPath: boolean
}

export type RowErrors = Partial<Record<CheckField, string>>

export const CHECKS_HINT =
  'Workers run these by name, as you, inside their worktree with a reduced environment. There is no shell: put one argument per line. This is not a sandbox.'

const DEFAULT_TIMEOUT_SEC = '60'

let nextKey = 1

export function newRow(partial: Partial<Omit<CheckRow, 'key'>> = {}): CheckRow {
  return {
    key: nextKey++,
    name: '',
    executable: '',
    args: '',
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    acceptsTestPath: false,
    ...partial
  }
}

export function rowsFromChecks(checks: readonly CheckConfig[] | undefined): CheckRow[] {
  return (checks ?? []).map((c) =>
    newRow({
      name: c.name,
      executable: c.executable,
      args: c.args.join('\n'),
      timeoutSec: String(c.timeoutMs / 1000),
      acceptsTestPath: c.acceptsTestPath === true
    })
  )
}

function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

function toCandidate(row: CheckRow): unknown {
  const trimmed = row.timeoutSec.trim()
  const seconds = trimmed === '' ? Number.NaN : Number(trimmed)
  return {
    name: row.name,
    executable: row.executable,
    args: parseArgs(row.args),
    timeoutMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN,
    ...(row.acceptsTestPath ? { acceptsTestPath: true } : {})
  }
}

const FIELD_OF_KEY: Record<string, CheckField> = {
  name: 'name',
  executable: 'executable',
  args: 'args',
  timeoutMs: 'timeout'
}

const FIELD_MESSAGES: Record<CheckField, string> = {
  name: 'Name must be 1 to 32 characters of a-z, 0-9 or -.',
  executable: 'Executable is required (at most 260 characters).',
  args: `At most 16 arguments, each 1 to 500 characters.`,
  timeout: 'Timeout must be between 1 and 600 seconds.'
}

export interface ChecksValidation {
  checks: CheckConfig[]
  /** Errors by row key; empty when every row is valid. */
  errors: Map<number, RowErrors>
}

export function validateRows(rows: readonly CheckRow[]): ChecksValidation {
  const checks: CheckConfig[] = []
  const errors = new Map<number, RowErrors>()
  const seen = new Set<string>()
  for (const row of rows) {
    const rowErrors: RowErrors = {}
    const parsed = checkSchema.safeParse(toCandidate(row))
    if (parsed.success) {
      checks.push(parsed.data)
    } else {
      for (const issue of parsed.error.issues) {
        const field = FIELD_OF_KEY[String(issue.path[0])]
        if (field && !rowErrors[field]) rowErrors[field] = FIELD_MESSAGES[field]
      }
    }
    if (seen.has(row.name) && !rowErrors.name) rowErrors.name = 'Check names must be unique.'
    seen.add(row.name)
    if (Object.keys(rowErrors).length > 0) errors.set(row.key, rowErrors)
  }
  return { checks, errors }
}

interface Props {
  rows: readonly CheckRow[]
  errors: ReadonlyMap<number, RowErrors>
  onChange: (rows: CheckRow[]) => void
}

export function ChecksEditor({ rows, errors, onChange }: Props) {
  const id = useId()

  function update(key: number, patch: Partial<CheckRow>) {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  return (
    <section className="settings__section" aria-label="Checks">
      <h3 className="settings__heading">Checks</h3>
      <p className="settings__hint">{CHECKS_HINT}</p>
      {rows.length === 0 ? <p className="settings__hint">No checks configured.</p> : null}
      {rows.map((row, i) => {
        const rowErrors = errors.get(row.key) ?? {}
        const p = `${id}-${row.key}`
        const field = (f: CheckField) => ({
          'aria-invalid': rowErrors[f] ? true : undefined,
          'aria-describedby': rowErrors[f] ? `${p}-${f}-err` : undefined
        })
        const err = (f: CheckField) =>
          rowErrors[f] ? (
            <p id={`${p}-${f}-err`} role="alert" className="settings__error">
              {rowErrors[f]}
            </p>
          ) : null
        return (
          <fieldset key={row.key} className="settings__check">
            <legend>{`Check ${i + 1}`}</legend>
            <div className="settings__field">
              <label htmlFor={`${p}-name`}>Name</label>
              <input
                id={`${p}-name`}
                type="text"
                value={row.name}
                spellCheck={false}
                {...field('name')}
                onChange={(e) => update(row.key, { name: e.target.value })}
              />
              {err('name')}
            </div>
            <div className="settings__field">
              <label htmlFor={`${p}-exe`}>Executable</label>
              <input
                id={`${p}-exe`}
                type="text"
                value={row.executable}
                spellCheck={false}
                {...field('executable')}
                onChange={(e) => update(row.key, { executable: e.target.value })}
              />
              {err('executable')}
            </div>
            <div className="settings__field">
              <label htmlFor={`${p}-args`}>Arguments (one per line)</label>
              <textarea
                id={`${p}-args`}
                value={row.args}
                spellCheck={false}
                {...field('args')}
                onChange={(e) => update(row.key, { args: e.target.value })}
              />
              {err('args')}
            </div>
            <div className="settings__field">
              <label htmlFor={`${p}-timeout`}>Timeout (seconds)</label>
              <input
                id={`${p}-timeout`}
                type="text"
                inputMode="decimal"
                value={row.timeoutSec}
                {...field('timeout')}
                onChange={(e) => update(row.key, { timeoutSec: e.target.value })}
              />
              {err('timeout')}
            </div>
            <label className="settings__toggle">
              <input
                type="checkbox"
                checked={row.acceptsTestPath}
                onChange={(e) => update(row.key, { acceptsTestPath: e.target.checked })}
              />
              Takes a test path
            </label>
            <button
              type="button"
              className="settings__small-button"
              aria-label={`Remove check ${i + 1}`}
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            >
              Remove
            </button>
          </fieldset>
        )
      })}
      <button
        type="button"
        className="settings__small-button"
        disabled={rows.length >= CHECKS_MAX_COUNT}
        onClick={() => onChange([...rows, newRow()])}
      >
        Add check
      </button>
    </section>
  )
}
