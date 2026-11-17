/**
 * Plan parser and validator.
 *
 * The plan format is a contract with the toolkit `plan` skill; a change there must be mirrored here.
 * - Waves are `### Wave <n>` headings (n ascending from 1) under a `## ... Tasks` section.
 * - Tasks are `### T<n>: <title>` blocks under a wave.
 * - Each task has the fields Status, Worker, Contract, Owns, Depends on, Acceptance criteria (bullets).
 *   Owns lists paths in backticks, comma separated; a path ending in `/` is a directory prefix.
 *   Depends on is `none` or task ids.
 * Parsing never throws: failures come back as errors naming the line and the rule.
 */
import path from 'node:path'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { createProtectedMatcher } from '../chat/protectedPaths'

export const MAX_PLAN_BYTES = 512 * 1024
export const MAX_PLAN_TASKS = 200
/** The workers named in the toolkit build skill. test-writer is deliberately absent (verify calls it). */
export const PLAN_WORKERS: readonly string[] = [
  'java-developer',
  'python-developer',
  'node-developer',
  'frontend-developer',
  'database-engineer'
]

export interface PlanTask {
  id: string
  title: string
  worker: string
  owns: string[]
  dependsOn: string[]
  acceptance: string[]
  contract: string
}

export interface PlanWave {
  n: number
  tasks: PlanTask[]
}

export interface ParsedPlan {
  title: string
  waves: PlanWave[]
}

export interface PlanError {
  /** 1-based line number (0 when the error is not tied to a line). */
  line: number
  message: string
}

export type PlanParseResult = { ok: true; plan: ParsedPlan } | { ok: false; errors: PlanError[] }

const FIELDS = ['Status', 'Worker', 'Contract', 'Owns', 'Depends on', 'Acceptance criteria'] as const
type Field = (typeof FIELDS)[number]

function normalizePath(p: string, platform: NodeJS.Platform): string {
  let n = p.replace(/\\/g, '/')
  while (n.startsWith('./')) n = n.slice(2)
  return platform === 'win32' ? n.toLowerCase() : n
}

/** Why a path may not appear in Owns (or be covered), or null when its shape is fine. */
function badPathShape(p: string): string | null {
  if (p.length === 0 || p.includes('\0')) return 'is empty or contains NUL'
  if (/^[/\\]/.test(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) return 'is absolute'
  if (p.includes(':')) return 'contains a drive colon'
  if (p.split(/[/\\]/).includes('..')) return 'contains ".."'
  return null
}

/**
 * True when `owns` covers the project-relative `relativePath`: a directory prefix (ends in `/`) covers files
 * under it, an exact path only itself. Case-insensitive on win32 only. `..` and absolute paths are never covered.
 */
export function ownsCovers(
  owns: readonly string[],
  relativePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (typeof relativePath !== 'string' || badPathShape(relativePath) !== null) return false
  const target = normalizePath(relativePath, platform)
  if (target === '' || target.endsWith('/')) return false
  for (const entry of owns) {
    if (typeof entry !== 'string' || badPathShape(entry) !== null) continue
    const o = normalizePath(entry, platform)
    if (o.endsWith('/')) {
      if (o.length > 1 && target.startsWith(o)) return true
    } else if (o === target) {
      return true
    }
  }
  return false
}

function pathsOverlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  const na = normalizePath(a, platform)
  const nb = normalizePath(b, platform)
  const ba = na.replace(/\/+$/, '')
  const bb = nb.replace(/\/+$/, '')
  if (ba === bb) return true
  if (na.endsWith('/') && bb.startsWith(ba + '/')) return true
  if (nb.endsWith('/') && ba.startsWith(bb + '/')) return true
  return false
}

function isDefaultProtected(p: string): boolean {
  const root = process.platform === 'win32' ? 'C:\\plan-root' : '/plan-root'
  const matcher = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot: root })
  const rel = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return matcher.isProtected(path.join(root, ...rel.split('/')))
}

interface DraftTask {
  id: string
  title: string
  line: number
  waveIndex: number
  fields: Map<Field, { line: number; value: string }>
  acceptance: string[]
  ownsLine: number
}

export function parsePlan(
  markdown: string,
  platform: NodeJS.Platform = process.platform,
  allowedWorkers: readonly string[] = PLAN_WORKERS
): PlanParseResult {
  if (typeof markdown !== 'string') return { ok: false, errors: [{ line: 0, message: 'plan is not text' }] }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_PLAN_BYTES) {
    return { ok: false, errors: [{ line: 0, message: `plan is larger than ${MAX_PLAN_BYTES / 1024} KiB` }] }
  }
  const lines = markdown.split(/\r?\n/)
  const taskCount = lines.filter((l) => /^###\s+T\d+\s*:/.test(l)).length
  if (taskCount > MAX_PLAN_TASKS) {
    return { ok: false, errors: [{ line: 0, message: `plan has more than ${MAX_PLAN_TASKS} tasks (${taskCount})` }] }
  }

  const errors: PlanError[] = []
  const err = (line: number, message: string): void => {
    errors.push({ line, message })
  }

  let title = ''
  let inTasks = false
  let sawTasksSection = false
  const waves: { n: number; line: number }[] = []
  const drafts: DraftTask[] = []
  let current: DraftTask | null = null
  let currentField: Field | null = null

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i] as string

    if (title === '' && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, '').replace(/^Plan:\s*/i, '').trim()
      continue
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      inTasks = /^##\s+(\d+\.\s*)?Tasks\b/i.test(line)
      if (inTasks) sawTasksSection = true
      current = null
      currentField = null
      continue
    }
    if (!inTasks) continue

    const heading = /^###\s+(.*)$/.exec(line)
    if (heading) {
      const text = (heading[1] as string).trim()
      current = null
      currentField = null
      const wave = /^Wave\s+(\d+)\s*$/.exec(text)
      if (wave) {
        const n = Number(wave[1])
        const expected = waves.length + 1
        if (n !== expected) err(lineNo, `wave heading must be "Wave ${expected}" (waves ascend from 1), found "Wave ${n}"`)
        waves.push({ n, line: lineNo })
        continue
      }
      const task = /^(T\d+)\s*:\s*(.+)$/.exec(text)
      if (task) {
        if (waves.length === 0) {
          err(lineNo, `task ${task[1]} appears before any "### Wave <n>" heading`)
          continue
        }
        current = {
          id: task[1] as string,
          title: (task[2] as string).trim(),
          line: lineNo,
          waveIndex: waves.length - 1,
          fields: new Map(),
          acceptance: [],
          ownsLine: lineNo
        }
        drafts.push(current)
        continue
      }
      err(lineNo, `unrecognized heading "${text}" in the tasks section (expected "Wave <n>" or "T<n>: <title>")`)
      continue
    }

    if (current === null) continue

    const field = /^-\s+([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line)
    if (field) {
      const name = field[1] as string
      if (!(FIELDS as readonly string[]).includes(name)) {
        err(lineNo, `unknown field "${name}" in task ${current.id}`)
        currentField = null
        continue
      }
      const f = name as Field
      if (current.fields.has(f)) {
        err(lineNo, `duplicate field "${f}" in task ${current.id}`)
        currentField = null
        continue
      }
      current.fields.set(f, { line: lineNo, value: (field[2] as string).trim() })
      if (f === 'Owns') current.ownsLine = lineNo
      currentField = f
      continue
    }

    if (currentField === 'Acceptance criteria') {
      const bullet = /^\s+[-*]\s+(.*)$/.exec(line)
      if (bullet) {
        current.acceptance.push((bullet[1] as string).trim())
      } else if (/^\s+\S/.test(line) && current.acceptance.length > 0) {
        const last = current.acceptance.length - 1
        current.acceptance[last] = `${current.acceptance[last]} ${line.trim()}`
      }
    }
  }

  if (title === '') err(0, 'plan has no "# " title line')
  if (!sawTasksSection) err(0, 'plan has no "## Tasks" section')
  else if (waves.length === 0) err(0, 'tasks section has no "### Wave <n>" heading')

  // Per-task validation and construction.
  const idToWave = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const d of drafts) {
    const first = seen.get(d.id)
    if (first !== undefined) err(d.line, `duplicate task id ${d.id} (first defined on line ${first})`)
    else {
      seen.set(d.id, d.line)
      idToWave.set(d.id, d.waveIndex)
    }
  }

  const built = new Map<string, PlanTask>()
  for (const d of drafts) {
    let valid = true
    for (const f of FIELDS) {
      if (!d.fields.has(f)) {
        err(d.line, `task ${d.id} is missing the field "${f}"`)
        valid = false
      }
    }
    if (!valid) continue

    const get = (f: Field): { line: number; value: string } => d.fields.get(f) as { line: number; value: string }

    const worker = get('Worker')
    if (!allowedWorkers.includes(worker.value)) {
      err(worker.line, `task ${d.id} has unknown worker "${worker.value}" (expected one of ${allowedWorkers.join(', ')})`)
      valid = false
    }

    const ownsField = get('Owns')
    const owns = [...ownsField.value.matchAll(/`([^`]*)`/g)].map((m) => (m[1] as string).trim())
    if (owns.length === 0) {
      err(ownsField.line, `task ${d.id} has an empty Owns (list paths in backticks)`)
      valid = false
    }
    for (const p of owns) {
      const shape = badPathShape(p)
      if (shape !== null) {
        err(ownsField.line, `task ${d.id} Owns path "${p}" ${shape}`)
        valid = false
      } else if (isDefaultProtected(p)) {
        err(ownsField.line, `task ${d.id} Owns path "${p}" matches the protected-path defaults`)
        valid = false
      }
    }

    const depField = get('Depends on')
    let dependsOn: string[] = []
    if (!/^none\.?$/i.test(depField.value)) {
      dependsOn = depField.value.split(/[\s,]+/).filter((s) => s !== '')
      for (const dep of dependsOn) {
        if (!/^T\d+$/.test(dep)) {
          err(depField.line, `task ${d.id} has an invalid dependency "${dep}" (expected "none" or task ids)`)
          valid = false
          continue
        }
        const depWave = idToWave.get(dep)
        if (depWave === undefined) {
          err(depField.line, `task ${d.id} depends on unknown task ${dep}`)
          valid = false
        } else if (depWave >= d.waveIndex) {
          err(depField.line, `task ${d.id} depends on ${dep}, which is in the same or a later wave`)
          valid = false
        }
      }
    }

    if (d.acceptance.length === 0) {
      err(get('Acceptance criteria').line, `task ${d.id} has no acceptance criteria bullets`)
      valid = false
    }

    if (valid && !built.has(d.id)) {
      built.set(d.id, {
        id: d.id,
        title: d.title,
        worker: worker.value,
        owns,
        dependsOn,
        acceptance: d.acceptance,
        contract: get('Contract').value
      })
    }
  }

  // Overlapping Owns between two tasks in the same wave.
  for (let w = 0; w < waves.length; w++) {
    const inWave = drafts.filter((d) => d.waveIndex === w && built.has(d.id))
    for (let a = 0; a < inWave.length; a++) {
      for (let b = a + 1; b < inWave.length; b++) {
        const ta = built.get((inWave[a] as DraftTask).id) as PlanTask
        const tb = built.get((inWave[b] as DraftTask).id) as PlanTask
        for (const pa of ta.owns) {
          const hit = tb.owns.find((pb) => pathsOverlap(pa, pb, platform))
          if (hit !== undefined) {
            err(
              (inWave[b] as DraftTask).ownsLine,
              `tasks ${ta.id} and ${tb.id} in wave ${w + 1} have overlapping Owns: "${pa}" and "${hit}"`
            )
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const planWaves: PlanWave[] = waves.map((wv, idx) => ({
    n: wv.n,
    tasks: drafts.filter((d) => d.waveIndex === idx).map((d) => built.get(d.id) as PlanTask)
  }))
  return { ok: true, plan: { title, waves: planWaves } }
}
