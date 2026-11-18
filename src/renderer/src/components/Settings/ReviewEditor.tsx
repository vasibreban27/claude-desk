import { useId } from 'react'
import type { ProjectSettings } from '@shared/ipc'
import {
  AUTO_FIX_ROUNDS_RANGE,
  DEFAULT_REVIEWERS,
  REVIEWER_NAMES,
  type ReviewerName
} from '@shared/review'

export interface ReviewValues {
  autoFixRounds: string
  reviewers: ReviewerName[]
}

export interface ReviewValidation {
  values: { autoFixRounds: number; reviewers: ReviewerName[] }
  error: string | null
}

const REVIEWER_LABELS: Record<ReviewerName, string> = {
  reviewer: 'Reviewer',
  'security-auditor': 'Security auditor'
}

const REVIEWER_HINTS: Record<ReviewerName, string> = {
  reviewer: 'Reads every task diff.',
  'security-auditor': 'Runs only for tasks marked Sensitive: yes.'
}

export function reviewFromSettings(settings: ProjectSettings): ReviewValues {
  return {
    autoFixRounds: String(settings.autoFixRounds ?? AUTO_FIX_ROUNDS_RANGE.default),
    reviewers: [...(settings.reviewers ?? DEFAULT_REVIEWERS)]
  }
}

export function validateReview(raw: ReviewValues): ReviewValidation {
  const text = raw.autoFixRounds.trim()
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
  const { min, max } = AUTO_FIX_ROUNDS_RANGE
  const reviewers = REVIEWER_NAMES.filter((r) => raw.reviewers.includes(r))
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      values: { autoFixRounds: AUTO_FIX_ROUNDS_RANGE.default, reviewers },
      error: `Enter a whole number from ${min} to ${max}.`
    }
  }
  return { values: { autoFixRounds: n, reviewers }, error: null }
}

interface Props {
  values: ReviewValues
  error: string | null
  onChange: (values: ReviewValues) => void
}

export function ReviewEditor({ values, error, onChange }: Props) {
  const id = useId()
  return (
    <section className="settings__section" aria-label="Review">
      <h3 className="settings__heading">Review</h3>
      <div className="settings__field">
        <label htmlFor={`${id}-rounds`}>Fix rounds</label>
        <input
          id={`${id}-rounds`}
          type="text"
          inputMode="numeric"
          value={values.autoFixRounds}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-rounds-hint${error ? ` ${id}-rounds-err` : ''}`}
          onChange={(e) => onChange({ ...values, autoFixRounds: e.target.value })}
        />
        <p id={`${id}-rounds-hint`} className="settings__hint">
          How many times a worker may fix failed checks or blocking findings before the task fails. 0 turns
          fixing off. Applies to the next run.
        </p>
        {error ? (
          <p id={`${id}-rounds-err`} role="alert" className="settings__error">
            {error}
          </p>
        ) : null}
      </div>
      <div className="settings__field">
        <p>Reviewers</p>
        {REVIEWER_NAMES.map((r) => (
          <div key={r}>
            <label className="settings__toggle">
              <input
                type="checkbox"
                checked={values.reviewers.includes(r)}
                onChange={(e) =>
                  onChange({
                    ...values,
                    reviewers: e.target.checked
                      ? [...values.reviewers.filter((x) => x !== r), r]
                      : values.reviewers.filter((x) => x !== r)
                  })
                }
              />
              {REVIEWER_LABELS[r]}
            </label>
            <p className="settings__hint">{REVIEWER_HINTS[r]}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
