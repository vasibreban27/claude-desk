import { useId } from 'react'
import {
  MAX_PARALLEL_LIMIT,
  MAX_TURNS_RANGE,
  TIME_LIMIT_MINUTES_RANGE,
  effectiveLimits,
  type ProjectSettings
} from '@shared/ipc'

export type LimitField = 'maxParallel' | 'maxTurns' | 'taskTimeoutMinutes'

/** The three limits as typed. */
export type LimitValues = Record<LimitField, string>
export type LimitErrors = Partial<Record<LimitField, string>>

export const PARALLEL_HINT =
  'More workers finish a plan sooner, but cost and machine load grow with the number. Applies to the next run.'

const RANGES: Record<LimitField, { min: number; max: number }> = {
  maxParallel: { min: 1, max: MAX_PARALLEL_LIMIT },
  maxTurns: { min: MAX_TURNS_RANGE.min, max: MAX_TURNS_RANGE.max },
  taskTimeoutMinutes: { min: TIME_LIMIT_MINUTES_RANGE.min, max: TIME_LIMIT_MINUTES_RANGE.max }
}

const LABELS: Record<LimitField, string> = {
  maxParallel: 'Workers at once',
  maxTurns: 'Max turns per task',
  taskTimeoutMinutes: 'Time limit per task (minutes)'
}
const HINTS: Record<LimitField, string> = {
  maxParallel: PARALLEL_HINT,
  maxTurns: 'Maximum assistant steps a worker can take before its task stops. Applies to the next run.',
  taskTimeoutMinutes: 'Maximum elapsed time for one task, including checks and review. Applies to the next run.'
}

const FIELDS: LimitField[] = ['maxParallel', 'maxTurns', 'taskTimeoutMinutes']

export function limitsFromSettings(settings: ProjectSettings): LimitValues {
  const l = effectiveLimits(settings)
  return {
    maxParallel: String(l.maxParallel),
    maxTurns: String(l.maxTurns),
    taskTimeoutMinutes: String(l.timeCapMs / 60000)
  }
}

export interface LimitsValidation {
  values: Record<LimitField, number>
  errors: LimitErrors
}

export function validateLimits(raw: LimitValues): LimitsValidation {
  const errors: LimitErrors = {}
  const values = { maxParallel: 0, maxTurns: 0, taskTimeoutMinutes: 0 }
  for (const f of FIELDS) {
    const text = raw[f].trim()
    const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
    const { min, max } = RANGES[f]
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[f] = `Enter a whole number from ${min} to ${max}.`
    } else {
      values[f] = n
    }
  }
  return { values, errors }
}

interface Props {
  values: LimitValues
  errors: LimitErrors
  onChange: (values: LimitValues) => void
}

export function LimitsEditor({ values, errors, onChange }: Props) {
  const id = useId()
  return (
    <section className="settings__section" aria-label="Limits">
      <h3 className="settings__heading">Limits</h3>
      {FIELDS.map((f) => {
        const err = errors[f]
        return (
          <div className="settings__field" key={f}>
            <label htmlFor={`${id}-${f}`}>{LABELS[f]}</label>
            <input
              id={`${id}-${f}`}
              type="text"
              inputMode="numeric"
              value={values[f]}
              aria-invalid={err ? true : undefined}
              aria-describedby={
                [`${id}-${f}-hint`, err ? `${id}-${f}-err` : null]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              onChange={(e) => onChange({ ...values, [f]: e.target.value })}
            />
            <p id={`${id}-${f}-hint`} className="settings__hint">{HINTS[f]}</p>
            {err ? (
              <p id={`${id}-${f}-err`} role="alert" className="settings__error">
                {err}
              </p>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
