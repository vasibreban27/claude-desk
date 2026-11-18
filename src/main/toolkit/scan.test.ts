import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES, parseFrontmatter, scanToolkit } from './scan'

let dir: string
const w = (rel: string, content: string): void => {
  const f = path.join(dir, rel)
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, content)
}
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fixture(): void {
  w('.claude-plugin/plugin.json', JSON.stringify({ name: 'flow', version: '0.10.0', description: 'd' }))
  w('agents/worker.md', '---\nname: worker\ndescription: Builds\nmodel: sonnet\ntools: Read, Edit\n---\nBody text')
  w('skills/plan/SKILL.md', '---\nname: plan\ndescription: Plans\n---\nSteps')
  w(
    'hooks/hooks.json',
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }] } })
  )
}

describe('scanToolkit', () => {
  it('lists plugin, agents, skills and hooks', async () => {
    fixture()
    const l = await scanToolkit(dir)
    expect(l.plugin).toEqual({ name: 'flow', version: '0.10.0', description: 'd' })
    expect(l.agents).toMatchObject([{ name: 'worker', model: 'sonnet', tools: ['Read', 'Edit'], body: 'Body text' }])
    expect(l.skills).toMatchObject([{ name: 'plan', source: 'skills/plan/SKILL.md' }])
    expect(l.hooks).toEqual([{ event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js', source: 'hooks/hooks.json' }])
    expect(l.problems).toEqual([])
  })

  it('reports bad frontmatter and keeps the valid files', async () => {
    fixture()
    w('agents/bad.md', 'no frontmatter here')
    w('agents/bad2.md', '---\nname: x\n---\nmissing description')
    const l = await scanToolkit(dir)
    expect(l.agents).toHaveLength(1)
    expect(l.problems.map((p) => p.file).sort()).toEqual(['agents/bad.md', 'agents/bad2.md'])
  })

  it('reports an oversized file', async () => {
    fixture()
    w('agents/huge.md', '---\nname: h\ndescription: d\n---\n' + 'x'.repeat(MAX_FILE_BYTES + 1))
    const l = await scanToolkit(dir)
    expect(l.problems).toEqual([{ file: 'agents/huge.md', reason: 'file too large' }])
  })

  it('reports invalid hooks json and invalid manifest', async () => {
    w('.claude-plugin/plugin.json', '{"nope":1}')
    w('hooks/hooks.json', '{not json')
    const l = await scanToolkit(dir)
    expect(l.plugin).toBeNull()
    expect(l.problems.map((p) => p.file).sort()).toEqual(['.claude-plugin/plugin.json', 'hooks/hooks.json'])
  })

  it('does not follow a symlink that leaves the toolkit folder', async () => {
    fixture()
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-'))
    try {
      writeFileSync(path.join(outside, 'x.md'), '---\nname: leak\ndescription: d\n---\nsecret')
      try {
        symlinkSync(path.join(outside, 'x.md'), path.join(dir, 'agents', 'leak.md'))
      } catch {
        return // symlinks not permitted on this machine
      }
      const l = await scanToolkit(dir)
      expect(l.agents.map((a) => a.name)).toEqual(['worker'])
      expect(l.problems).toEqual([{ file: 'agents/leak.md', reason: 'symlink outside toolkit' }])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a missing folder', async () => {
    await expect(scanToolkit(path.join(dir, 'nope'))).rejects.toThrow()
  })
})

describe('parseFrontmatter', () => {
  it('strips quotes and returns the body', () => {
    expect(parseFrontmatter('---\na: "b"\n---\nrest')).toEqual({ data: { a: 'b' }, body: 'rest' })
    expect(parseFrontmatter('none')).toBeNull()
  })
})
