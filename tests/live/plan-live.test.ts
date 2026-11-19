import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSdkRunner, type RunnerItem } from '../../src/main/chat/runner'
import { framePlanFormat, loadPlanFormat, PLAN_COMMAND } from '../../src/main/chat/plans'
import { defaultSettings } from '../../src/shared/settings'

/** Runs ONLY with CLAUDE_DESK_LIVE=1 and CLAUDE_TOOLKIT_PATH: the toolkit plan skill writes a plan from a chat turn. */
const LIVE = process.env['CLAUDE_DESK_LIVE'] === '1'
const TOOLKIT = process.env['CLAUDE_TOOLKIT_PATH'] ?? ''

describe.skipIf(!LIVE || TOOLKIT === '')('plan mode (live)', () => {
  it('runs /flow:plan and writes docs/plans/*.md', async () => {
    const cwd = realpathSync.native(mkdtempSync(path.join(realpathSync.native(tmpdir()), 'plan-live-')))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
    const run = createSdkRunner()
    const format = await loadPlanFormat(TOOLKIT)
    const settings = { ...defaultSettings(), model: 'opus' as const, allowPlanWrites: true }
    const kinds: string[] = []
    let session: string | undefined
    let text = ''
    const turn = async (prompt: string): Promise<void> => {
      for await (const item of run({
        prompt,
        cwd,
        pluginPath: TOOLKIT,
        settings,
        ...(session ? { resume: session } : {}),
        ...(format ? { appendPrompt: framePlanFormat(format) } : {})
      }) as AsyncIterable<RunnerItem>) {
        if (item.kind === 'session') session = item.sessionId
        if (item.kind === 'text') text += item.text
        if (item.kind === 'activity') kinds.push(JSON.stringify(item.draft).slice(0, 400))
      }
    }
    await turn(`${PLAN_COMMAND} A tiny Node script hello.js that prints hello, with one test. Keep it to one task.`)
    if (!existsSync(path.join(cwd, 'docs', 'plans'))) await turn('accept all recommended')
    console.log(kinds.join('\n'))
    console.log('TEXT:', text.slice(-1500))
    const plans = existsSync(path.join(cwd, 'docs', 'plans')) ? readdirSync(path.join(cwd, 'docs', 'plans')) : []
    console.log('plans:', plans, 'format loaded:', format !== null)
    expect(plans.some((p) => p.endsWith('.md'))).toBe(true)
  }, 600_000)
})
