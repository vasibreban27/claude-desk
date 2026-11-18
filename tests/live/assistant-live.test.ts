import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSdkRunner, type RunnerItem } from '../../src/main/chat/runner'

/** Runs ONLY with CLAUDE_DESK_LIVE=1: checks that the assistant really calls create_project. */
const LIVE = process.env['CLAUDE_DESK_LIVE'] === '1'

describe.skipIf(!LIVE)('assistant (live)', () => {
  it('emits a proposal item for a create request', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'assistant-live-'))
    const items: RunnerItem[] = []
    try {
      for await (const item of createSdkRunner()({
        prompt: 'Create a project called demo-live for a tiny todo API in FastAPI.',
        cwd,
        pluginPath: cwd,
        assistant: true
      })) {
        items.push(item)
      }
    } finally {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        // the SDK process may still hold the folder on Windows
      }
    }
    const summary = items.map((i) => (i.kind === 'activity' ? `activity:${JSON.stringify(i.draft).slice(0, 200)}` : i.kind === 'text' ? 'text' : `${i.kind}:${JSON.stringify(i).slice(0, 300)}`))
    console.log([...new Set(summary)].join('\n'))
    expect(items.some((i) => i.kind === 'proposal')).toBe(true)
  }, 180_000)
})
