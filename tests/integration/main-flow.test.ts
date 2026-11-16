import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from '../../src/main/chat/service'
import type { ChatRunner } from '../../src/main/chat/runner'
import { readGitStatus } from '../../src/main/git/status'
import { createHandlers } from '../../src/main/ipc/handlers'
import { openJsonProjectStore } from '../../src/main/projects/store'
import type { ChatEvent } from '../../src/shared/ipc'

// git is spawned here: allow more time than the global default, only for this file
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd })
}

describe('main-side flow (SDK mocked, real git and store)', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'desk-int-')))
    repo = join(root, 'repo')
    git(root, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    writeFileSync(join(repo, 'b.txt'), 'untracked')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  it('adds a project, lists it, streams a chat turn and returns history', async () => {
    const store = await openJsonProjectStore(join(root, 'data'))
    const events: ChatEvent[] = []
    let finish: () => void = () => {}
    const finished = new Promise<void>((r) => (finish = r))
    const calls: Array<{ cwd: string; pluginPath: string }> = []
    const runner: ChatRunner = async function* (args) {
      calls.push({ cwd: args.cwd, pluginPath: args.pluginPath })
      yield { kind: 'text', text: 'Hel' }
      yield { kind: 'text', text: 'lo' }
    }
    const paths = new Map<string, string>()
    const chat = new ChatService({
      resolveProjectPath: (id) => paths.get(id),
      runner,
      emit: (e) => {
        events.push(e)
        if (e.type !== 'text-delta') finish()
      },
      loadConfig: () => ({ ok: true, config: { toolkitPath: '/toolkit' } })
    })
    const h = createHandlers({ store, readGitStatus, pickFolder: async () => repo, chat })

    const added = await h.pickAndAdd()
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.project).toMatchObject({ branch: 'main', dirty: true, name: 'repo' })
    paths.set(added.project.id, added.project.path)

    expect(await h.pickAndAdd()).toEqual({ ok: false, error: 'duplicate' })
    expect(await h.listProjects()).toEqual([added.project])

    const sent = await h.chatSend({ projectId: added.project.id, text: 'hi' })
    expect(sent.ok).toBe(true)
    await finished

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'done'])
    expect(events.every((e) => e.projectId === added.project.id)).toBe(true)
    expect(calls).toEqual([{ cwd: added.project.path, pluginPath: '/toolkit' }])

    const history = await h.chatHistory({ projectId: added.project.id })
    expect(history.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello']
    ])
  })
})
