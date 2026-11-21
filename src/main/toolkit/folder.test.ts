import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findToolkitPlugin, readToolkitGit, updateToolkit, type GitExec } from './folder'

let root: string
const plugin = (dir: string): void => {
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"x"}')
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tk-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('findToolkitPlugin', () => {
  it('accepts a plugin folder itself', () => {
    plugin(root)
    expect(findToolkitPlugin(root)).toBe(path.resolve(root))
  })

  it('finds the plugin inside a claude-toolkit clone, preferring flow when there are several', () => {
    plugin(path.join(root, 'plugins', 'only'))
    expect(findToolkitPlugin(root)).toBe(path.join(path.resolve(root), 'plugins', 'only'))
    plugin(path.join(root, 'plugins', 'flow'))
    expect(findToolkitPlugin(root)).toBe(path.join(path.resolve(root), 'plugins', 'flow'))
  })

  it('returns null when there is no plugin', () => {
    expect(findToolkitPlugin(root)).toBeNull()
    plugin(path.join(root, 'plugins', 'a'))
    plugin(path.join(root, 'plugins', 'b'))
    expect(findToolkitPlugin(root)).toBeNull()
  })
})

/** A fake git: answers by the first argument. */
function fakeGit(answers: Record<string, string | Error | (() => string)>): ReturnType<typeof vi.fn<GitExec>> {
  return vi.fn<GitExec>(async (_cwd, args) => {
    const a = answers[args[0] as string]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : (a ?? '')
  })
}

describe('readToolkitGit', () => {
  it('reads branch, last commit and uncommitted state', async () => {
    const exec = fakeGit({ 'rev-parse': 'main\n', log: 'abc1234\u00002026-11-20\u0000feat: x\n', status: ' M agents/a.md\n' })
    expect(await readToolkitGit('/tk', exec)).toEqual({ branch: 'main', commit: 'abc1234', date: '2026-11-20', subject: 'feat: x', dirty: true })
  })

  it('is null outside a git repo', async () => {
    expect(await readToolkitGit('/tk', fakeGit({ 'rev-parse': new Error('not a repo') }))).toBeNull()
  })
})

describe('updateToolkit', () => {
  it('fast-forwards and reports the new commit', async () => {
    let commit = 'abc1234'
    const exec = fakeGit({
      'rev-parse': 'main',
      log: () => `${commit}\u00002026-11-20\u0000s`,
      status: '',
      pull: () => {
        commit = 'def5678'
        return ''
      }
    })
    expect(await updateToolkit('/tk', exec)).toEqual({ ok: true, updated: true, from: 'abc1234', to: 'def5678' })
    expect(exec).toHaveBeenCalledWith('/tk', ['pull', '--ff-only', '--quiet'], 120_000)
  })

  it('refuses with uncommitted changes or a detached HEAD, and reports a failed pull', async () => {
    expect(await updateToolkit('/tk', fakeGit({ 'rev-parse': 'main', log: 'a\u0000d\u0000s', status: ' M x' }))).toMatchObject({ ok: false, error: 'dirty' })
    expect(await updateToolkit('/tk', fakeGit({ 'rev-parse': 'HEAD', log: 'a\u0000d\u0000s', status: '' }))).toMatchObject({ ok: false, error: 'failed' })
    const failing = fakeGit({ 'rev-parse': 'main', log: 'a\u0000d\u0000s', status: '', pull: Object.assign(new Error('x'), { stderr: 'fatal: Not possible to fast-forward' }) })
    expect(await updateToolkit('/tk', failing)).toEqual({ ok: false, error: 'failed', message: 'git pull failed: fatal: Not possible to fast-forward' })
    expect(await updateToolkit('/tk', fakeGit({ 'rev-parse': new Error('no') }))).toMatchObject({ ok: false, error: 'not-a-repo' })
  })
})
