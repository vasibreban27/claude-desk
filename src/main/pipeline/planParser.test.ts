import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_PLAN_BYTES, ownsCovers, parsePlan, type PlanError } from './planParser'

interface TaskSpec {
  id: string
  worker?: string
  owns?: string
  deps?: string
  omit?: string
  extra?: string[]
}

function task(t: TaskSpec): string {
  const f: Record<string, string> = {
    Status: '- Status: [ ] todo',
    Worker: `- Worker: ${t.worker ?? 'node-developer'}`,
    Contract: '- Contract: none',
    Owns: `- Owns: ${t.owns ?? `\`src/${t.id}.ts\``}`,
    'Depends on': `- Depends on: ${t.deps ?? 'none'}`,
    'Acceptance criteria': '- Acceptance criteria:\n  - Given x When y Then z'
  }
  if (t.omit) delete f[t.omit]
  return [`### ${t.id}: Title ${t.id}`, ...Object.values(f), ...(t.extra ?? [])].join('\n')
}

function plan(waves: string[][]): string {
  const body = waves.map((w, i) => [`### Wave ${i + 1}`, '', ...w.map((t) => t + '\n')].join('\n')).join('\n')
  return `# Plan: Demo\n\n## 7. Tasks\n\n${body}\n## 8. Wave summary\n\n### not a task\n`
}

function errorsOf(md: string): PlanError[] {
  const r = parsePlan(md, 'linux')
  if (r.ok) throw new Error('expected failure')
  return r.errors
}

describe('parsePlan', () => {
  it('parses the real phase 3 plan', () => {
    const md = readFileSync(path.join(process.cwd(), 'docs/plans/phase-3-project-settings.md'), 'utf8')
    const r = parsePlan(md)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.waves).toHaveLength(6)
    expect(r.plan.waves.flatMap((w) => w.tasks)).toHaveLength(11)
    const t1 = r.plan.waves[0]?.tasks[0]
    expect(t1?.id).toBe('T1')
    expect(t1?.owns).toEqual(['docs/notes/phase-3-spike.md'])
    const t3 = r.plan.waves.flatMap((w) => w.tasks).find((t) => t.id === 'T3')
    expect(t3?.owns).toHaveLength(4)
    expect(t3?.contract).toBe('settings:get, settings:set, app:info')
    const multi = r.plan.waves.flatMap((w) => w.tasks).find((t) => t.dependsOn.length === 3)
    expect(multi?.dependsOn.every((d) => /^T\d+$/.test(d))).toBe(true)
  })

  it('default worker list accepts the five toolkit workers and rejects test-writer', () => {
    for (const worker of ['java-developer', 'python-developer', 'node-developer', 'frontend-developer', 'database-engineer']) {
      expect(parsePlan(plan([[task({ id: 'T1', worker })]]), 'linux').ok).toBe(true)
    }
    const errs = errorsOf(plan([[task({ id: 'T1', worker: 'test-writer' })]]))
    expect(errs.some((e) => e.message.includes('unknown worker "test-writer"'))).toBe(true)
  })

  it('honours a custom worker list', () => {
    const md = plan([[task({ id: 'T1', worker: 'rust-developer' })]])
    expect(parsePlan(md, 'linux').ok).toBe(false)
    expect(parsePlan(md, 'linux', ['rust-developer']).ok).toBe(true)
    const r = parsePlan(plan([[task({ id: 'T1', worker: 'node-developer' })]]), 'linux', ['rust-developer'])
    expect(r.ok).toBe(false)
  })

  it('parses a small valid plan', () => {
    const r = parsePlan(plan([[task({ id: 'T1' }), task({ id: 'T2' })], [task({ id: 'T3', deps: 'T1, T2' })]]), 'linux')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.title).toBe('Demo')
    expect(r.plan.waves.map((w) => w.tasks.map((t) => t.id))).toEqual([['T1', 'T2'], ['T3']])
    expect(r.plan.waves[1]?.tasks[0]?.dependsOn).toEqual(['T1', 'T2'])
    expect(r.plan.waves[0]?.tasks[0]?.acceptance).toEqual(['Given x When y Then z'])
  })

  it('reports a missing field with the task line', () => {
    const md = plan([[task({ id: 'T1', omit: 'Contract' })]])
    const e = errorsOf(md)
    expect(e[0]?.message).toContain('missing the field "Contract"')
    expect(e[0]?.line).toBe(md.split('\n').findIndex((l) => l.startsWith('### T1')) + 1)
  })

  it('reports an unknown field and a duplicate field', () => {
    expect(errorsOf(plan([[task({ id: 'T1', extra: ['- Bogus: 1'] })]]))[0]?.message).toContain('unknown field "Bogus"')
    expect(errorsOf(plan([[task({ id: 'T1', extra: ['- Worker: node-developer'] })]]))[0]?.message).toContain('duplicate field')
  })

  it('rejects a duplicate id', () => {
    const e = errorsOf(plan([[task({ id: 'T1' })], [task({ id: 'T1', owns: '`a.ts`' })]]))
    expect(e.some((x) => x.message.includes('duplicate task id T1'))).toBe(true)
  })

  it('rejects unknown, same-wave and later-wave dependencies', () => {
    expect(errorsOf(plan([[task({ id: 'T1', deps: 'T9' })]]))[0]?.message).toContain('unknown task T9')
    expect(errorsOf(plan([[task({ id: 'T1' }), task({ id: 'T2', deps: 'T1' })]]))[0]?.message).toContain('same or a later wave')
    expect(errorsOf(plan([[task({ id: 'T1', deps: 'T2' })], [task({ id: 'T2' })]]))[0]?.message).toContain('same or a later wave')
  })

  it('rejects an unknown worker', () => {
    expect(errorsOf(plan([[task({ id: 'T1', worker: 'wizard' })]]))[0]?.message).toContain('unknown worker "wizard"')
  })

  it.each([
    ['empty', '', 'empty Owns'],
    ['absolute', '`/etc/passwd`', 'is absolute'],
    ['windows absolute', '`C:\\x\\y.ts`', 'is absolute'],
    ['dotdot', '`src/../x.ts`', '".."'],
    ['drive colon', '`a:b.ts`', 'drive colon'],
    ['protected env', '`.env`', 'protected-path'],
    ['protected git dir', '`.git/`', 'protected-path'],
    ['protected key', '`certs/server.key`', 'protected-path']
  ])('rejects Owns that is %s', (_n, owns, msg) => {
    const e = errorsOf(plan([[task({ id: 'T1', owns })]]))
    expect(e[0]?.message).toContain(msg)
    expect(e[0]?.line).toBeGreaterThan(0)
  })

  it('allows .env.example (protected default exception)', () => {
    expect(parsePlan(plan([[task({ id: 'T1', owns: '`.env.example`' })]]), 'linux').ok).toBe(true)
  })

  it('rejects overlapping Owns in one wave, naming both tasks and the path', () => {
    const e = errorsOf(plan([[task({ id: 'T1', owns: '`src/a/`' }), task({ id: 'T2', owns: '`src/a/b.ts`' })]]))
    expect(e[0]?.message).toContain('T1')
    expect(e[0]?.message).toContain('T2')
    expect(e[0]?.message).toContain('src/a/b.ts')
    const same = errorsOf(plan([[task({ id: 'T1', owns: '`x.ts`' }), task({ id: 'T2', owns: '`x.ts`' })]]))
    expect(same[0]?.message).toContain('overlapping')
  })

  it('allows shared files across waves and disjoint prefixes in one wave', () => {
    const shared = plan([[task({ id: 'T1', owns: '`x.ts`' })], [task({ id: 'T2', owns: '`x.ts`', deps: 'T1' })]])
    expect(parsePlan(shared, 'linux').ok).toBe(true)
    const disjoint = plan([[task({ id: 'T1', owns: '`src/a/`' }), task({ id: 'T2', owns: '`src/ab/`' })]])
    expect(parsePlan(disjoint, 'linux').ok).toBe(true)
  })

  it('rejects wave numbering gaps', () => {
    const md = plan([[task({ id: 'T1' })]]).replace('### Wave 1', '### Wave 2')
    expect(errorsOf(md)[0]?.message).toContain('Wave 1')
  })

  it('rejects an oversized plan and too many tasks before parsing', () => {
    const big = parsePlan('x'.repeat(MAX_PLAN_BYTES + 1))
    expect(big.ok).toBe(false)
    const many = Array.from({ length: 201 }, (_, i) => `### T${i + 1}: t`).join('\n')
    const r = parsePlan(many)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]?.message).toContain('more than 200 tasks')
  })

  it('does not throw on garbage input', () => {
    expect(parsePlan('').ok).toBe(false)
    expect(parsePlan(undefined as unknown as string).ok).toBe(false)
  })
})

describe('ownsCovers', () => {
  it('covers files under a directory prefix and exact paths only', () => {
    expect(ownsCovers(['src/a/'], 'src/a/b/c.ts', 'linux')).toBe(true)
    expect(ownsCovers(['src/a/'], 'src/ab/c.ts', 'linux')).toBe(false)
    expect(ownsCovers(['src/a.ts'], 'src/a.ts', 'linux')).toBe(true)
    expect(ownsCovers(['src/a.ts'], 'src/a.ts/x', 'linux')).toBe(false)
    expect(ownsCovers(['src/a/'], 'src/a/', 'linux')).toBe(false)
  })

  it('is case-insensitive on win32 only', () => {
    expect(ownsCovers(['Src/A.ts'], 'src/a.ts', 'win32')).toBe(true)
    expect(ownsCovers(['Src/A.ts'], 'src/a.ts', 'linux')).toBe(false)
  })

  it('never covers .. or absolute paths', () => {
    expect(ownsCovers(['src/'], 'src/../x.ts', 'linux')).toBe(false)
    expect(ownsCovers(['src/'], '/src/x.ts', 'linux')).toBe(false)
    expect(ownsCovers(['src/'], 'C:\\src\\x.ts', 'win32')).toBe(false)
    expect(ownsCovers(['../'], 'x.ts', 'linux')).toBe(false)
  })
})
