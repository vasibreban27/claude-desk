import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { PLAN_FILE_PATTERN } from '../../shared/ipc'
import { MAX_PLAN_BYTES, parsePlan } from '../pipeline/planParser'

/** The toolkit plan skill (plugin `flow`). */
export const PLAN_COMMAND = '/flow:plan'
const MAX_PLANS = 200

export interface PlanFound {
  planFile: string
  /** First parse error, or null when the pipeline can run it. */
  problem: string | null
}

/** Regular docs/plans/*.md files modified at or after `sinceMs`, newest first, each checked with parsePlan. */
export async function findPlansWrittenSince(projectPath: string, sinceMs: number): Promise<PlanFound[]> {
  const dir = path.join(projectPath, 'docs', 'plans')
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => PLAN_FILE_PATTERN.test(n)).slice(0, MAX_PLANS)
  } catch {
    return []
  }
  const hits: { planFile: string; mtime: number; problem: string | null }[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.mtimeMs < sinceMs - 1000) continue
      let problem: string | null = null
      if (st.size > MAX_PLAN_BYTES) problem = 'plan file is too large'
      else {
        const parsed = parsePlan(await readFile(file, 'utf8'))
        if (!parsed.ok) {
          const e = parsed.errors[0]
          problem = e ? `line ${e.line}: ${e.message}`.slice(0, 300) : 'invalid plan'
        }
      }
      hits.push({ planFile: name, mtime: st.mtimeMs, problem })
    } catch {
      // unreadable: skip
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime).map(({ planFile, problem }) => ({ planFile, problem }))
}

const MAX_FORMAT_BYTES = 64 * 1024

/**
 * The toolkit's plan format (`docs/plan-format.md`), looked up in the plugin folder and then in the toolkit
 * repo root two levels up. Null when absent or too large. Read-only, never executed.
 */
export async function loadPlanFormat(pluginPath: string): Promise<string | null> {
  for (const candidate of [path.join(pluginPath, 'docs', 'plan-format.md'), path.join(pluginPath, '..', '..', 'docs', 'plan-format.md')]) {
    try {
      const st = await lstat(candidate)
      if (!st.isFile() || st.size > MAX_FORMAT_BYTES) continue
      return await readFile(candidate, 'utf8')
    } catch {
      // try the next one
    }
  }
  return null
}

export function framePlanFormat(format: string): string {
  return [
    'You are running the flow:plan skill inside claude-desk. Shell commands are not available: skip plan-lint',
    '(the app validates the plan when you write it). You may write only docs/plans/<slug>.md.',
    'The plan format referenced by the skill as docs/plan-format.md follows:',
    '<plan-format>',
    format,
    '</plan-format>'
  ].join('\n')
}
