import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }))

import { GIT_TIMEOUT_MS, readGitStatus } from './status'

afterEach(() => execFileMock.mockReset())

describe('git process spawning', () => {
  it('uses execFile with an argument array, cwd and timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-gitmock-'))
    execFileMock.mockImplementation((_cmd, args: string[], _opts, cb) => {
      const out = args[0] === 'rev-parse' ? 'true\n' : args[0] === 'symbolic-ref' ? 'main\n' : ''
      cb(null, out, '')
    })
    const res = await readGitStatus(dir)
    expect(res).toEqual({ ok: true, branch: 'main', dirty: false })
    expect(execFileMock).toHaveBeenCalled()
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).toBe('git')
      expect(Array.isArray(call[1])).toBe(true)
      expect(call[2]).toMatchObject({ cwd: dir, timeout: GIT_TIMEOUT_MS })
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps a spawn failure (git missing) to unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-gitmock-'))
    execFileMock.mockImplementation((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', '')
    )
    expect(await readGitStatus(dir)).toEqual({ ok: false, error: 'unreadable' })
    rmSync(dir, { recursive: true, force: true })
  })
})
