import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findPlansWrittenSince, loadPlanFormat } from './plans'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plans-'))
  mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const VALID = [
  '# Plan: demo',
  '',
  '## 7. Tasks',
  '',
  '### Wave 1',
  '',
  '### T1: title',
  '- Status: [ ] todo',
  '- Worker: node-developer',
  '- Contract: none',
  '- Owns: `src/a.ts`',
  '- Depends on: none',
  '- Acceptance criteria:',
  '  - works',
  ''
].join('\n')

describe('findPlansWrittenSince', () => {
  it('returns only plans changed since the turn, with parse problems', async () => {
    const plans = path.join(dir, 'docs', 'plans')
    writeFileSync(path.join(plans, 'old.md'), VALID)
    const old = new Date(Date.now() - 3600_000)
    utimesSync(path.join(plans, 'old.md'), old, old)
    const since = Date.now()
    writeFileSync(path.join(plans, 'new.md'), VALID)
    writeFileSync(path.join(plans, 'broken.md'), '# nothing')
    writeFileSync(path.join(plans, 'notes.txt'), 'x')
    const found = await findPlansWrittenSince(dir, since)
    expect(found.map((f) => f.planFile).sort()).toEqual(['broken.md', 'new.md'])
    expect(found.find((f) => f.planFile === 'new.md')?.problem).toBeNull()
    expect(found.find((f) => f.planFile === 'broken.md')?.problem).toEqual(expect.any(String))
  })

  it('returns nothing when docs/plans is missing', async () => {
    expect(await findPlansWrittenSince(path.join(dir, 'nope'), 0)).toEqual([])
  })
})

describe('loadPlanFormat', () => {
  it('finds the format in the toolkit root two levels above the plugin, or null', async () => {
    const plugin = path.join(dir, 'plugins', 'flow')
    mkdirSync(plugin, { recursive: true })
    expect(await loadPlanFormat(plugin)).toBeNull()
    writeFileSync(path.join(dir, 'docs', 'plan-format.md'), 'Format: flow-plan/1')
    expect(await loadPlanFormat(plugin)).toBe('Format: flow-plan/1')
  })
})
