/** Same rule as the main process (`validProjectName`): 2-49 lowercase letters, digits or hyphens. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/
const MAX_WORDS = 3
const MAX_LENGTH = 40
export const FALLBACK_NAME = 'new-project'

/** Filler words that say nothing about the app. */
const STOP = new Set(
  (
    'a an the i we me my our you your want wanna would like need please lets let us can could should ' +
    'to for of in on with and or that which who is be it this some simple small basic new ' +
    'build make create write develop start code implement design app application project'
  ).split(' ')
)

/**
 * A folder name from the first chat message, without a model call: the first few meaningful words.
 * "I want a todo API in FastAPI" -> "todo-api-fastapi". Never returns an invalid name.
 */
export function projectNameFrom(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP.has(w))
  let name = ''
  for (const w of words.slice(0, MAX_WORDS)) {
    const next = name === '' ? w : `${name}-${w}`
    if (next.length > MAX_LENGTH) break
    name = next
  }
  return NAME_RE.test(name) ? name : FALLBACK_NAME
}

/** `name`, then `name-2`, `name-3`, ... for retries when the folder exists. */
export function numbered(name: string, attempt: number): string {
  return attempt <= 1 ? name : `${name.slice(0, MAX_LENGTH)}-${attempt}`
}
