import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_BUFFER_MAX,
  CHAT_TEXT_MAX,
  IPC,
  REVIEWER_NAMES,
  isBlocking,
  type PipelineTaskView,
  activityHistoryRequestSchema,
  chatHistoryRequestSchema,
  chatSendRequestSchema,
  defaultSettings,
  projectsRefreshRequestSchema,
  settingsGetRequestSchema,
  settingsSetRequestSchema,
  usageSummaryRequestSchema
} from './ipc'

describe('phase 5a contract', () => {
  it('exports review constants and the grown view shape through ipc', () => {
    const view: PipelineTaskView = {
      taskId: 'T1',
      title: 't',
      worker: 'node-developer',
      wave: 1,
      dependsOn: [],
      status: 'running',
      reason: null,
      commit: null,
      checks: null,
      turns: null,
      costUsd: null,
      durationMs: null,
      stage: 'review',
      fixRounds: 1,
      findings: { blocking: 1, minor: 0, items: [] }
    }
    expect(view.stage).toBe('review')
    expect(isBlocking({ severity: 'blocker' })).toBe(true)
    expect(REVIEWER_NAMES).toEqual(['reviewer', 'security-auditor'])
  })

  it('rejects a settings:set payload with autoFixRounds 1000', () => {
    const r = settingsSetRequestSchema.safeParse({
      projectId: uuid,
      settings: { ...defaultSettings(), autoFixRounds: 1000 }
    })
    expect(r.success).toBe(false)
  })
})

const uuid ='2f1b6c3e-8d5a-4c1e-9b7a-3e6f1d2c4a5b'

describe('IPC channels', () => {
  it('names every channel from the contract', () => {
    expect(Object.values(IPC).sort()).toEqual(
      [
        'projects:list',
        'projects:pick-and-add',
        'projects:refresh',
        'chat:history',
        'chat:send',
        'chat:event',
        'activity:event',
        'activity:history',
        'activity:runs',
        'activity:events',
        'activity:trace',
        'pipeline:branch',
        'usage:summary',
        'usage:plan',
        'settings:get',
        'settings:set',
        'settings:suggestions',
        'app:info',
        'app:model-get',
        'app:model-set',
        'toolkit:list',
        'projects:create',
        'projects:root-get',
        'projects:root-pick',
        'projects:remove',
        'pipeline:plans',
        'pipeline:start',
        'pipeline:status',
        'pipeline:cancel',
        'pipeline:resume',
        'pipeline:discard',
        'pipeline:merge',
        'pipeline:pr',
        'app:open-url',
        'mcp:list',
        'mcp:save',
        'mcp:delete',
        'mcp:test',
        'speech:transcribe',
        'speech:progress',
        'agents:view',
        'agents:save',
        'agents:rules',
        'agents:preview',
        'pipeline:log',
        'pipeline:log-event',
        'pipeline:event'
      ].sort()
    )
  })
})

describe('request schemas', () => {
  it('parses valid payloads', () => {
    expect(projectsRefreshRequestSchema.safeParse({ id: uuid }).success).toBe(true)
    expect(chatHistoryRequestSchema.safeParse({ projectId: uuid }).success).toBe(true)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi' }).success).toBe(true)
  })

  it('rejects a bad uuid', () => {
    expect(projectsRefreshRequestSchema.safeParse({ id: 'nope' }).success).toBe(false)
    expect(chatHistoryRequestSchema.safeParse({ projectId: '123' }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: 'x', text: 'hi' }).success).toBe(false)
  })

  it('accepts attachments, alone or with text, and checks their shape', () => {
    const image = { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    const file = { kind: 'file', name: 'a.pdf', data: 'JVBERg==' }
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: '', attachments: [image] }).success).toBe(true)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', attachments: [image, file] }).success).toBe(true)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: ' ', attachments: [] }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', attachments: [{ ...image, mediaType: 'image/svg+xml' }] }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', attachments: [{ ...file, data: 'not base64!' }] }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', attachments: [{ ...file, extra: 1 }] }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', attachments: Array(11).fill(file) }).success).toBe(false)
  })

  it('rejects empty text and wrong shapes', () => {
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: '' }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 5 }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse(null).success).toBe(false)
    expect(chatHistoryRequestSchema.safeParse({}).success).toBe(false)
  })

  it('accepts text of exactly 20000 characters and rejects 20001', () => {
    expect(CHAT_TEXT_MAX).toBe(20000)
    const ok = chatSendRequestSchema.safeParse({ projectId: uuid, text: 'a'.repeat(20000) })
    const tooLong = chatSendRequestSchema.safeParse({ projectId: uuid, text: 'a'.repeat(20001) })
    expect(ok.success).toBe(true)
    expect(tooLong.success).toBe(false)
  })
})

describe('shared module hygiene', () => {
  const src = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
  it('has no any and no node or electron imports', () => {
    expect(src).not.toMatch(/:\s*any\b|\bas any\b|<any>/)
    expect(src).not.toMatch(/from ['"](node:|electron|fs|path)/)
  })
})

describe('phase 3 contract', () => {
  it('validates settings request schemas', () => {
    const settings = defaultSettings()
    expect(settingsGetRequestSchema.safeParse({ projectId: uuid }).success).toBe(true)
    expect(settingsGetRequestSchema.safeParse({ projectId: 'nope' }).success).toBe(false)
    expect(settingsSetRequestSchema.safeParse({ projectId: uuid, settings }).success).toBe(true)
    expect(settingsSetRequestSchema.safeParse({ projectId: 'x', settings }).success).toBe(false)
    expect(
      settingsSetRequestSchema.safeParse({ projectId: uuid, settings: { ...settings, version: 2 } })
        .success
    ).toBe(false)
  })
})

describe('phase 2 contract', () => {
  it('names the activity and usage channels', () => {
    expect(IPC.activityEvent).toBe('activity:event')
    expect(IPC.activityHistory).toBe('activity:history')
    expect(IPC.usageSummary).toBe('usage:summary')
    expect(ACTIVITY_BUFFER_MAX).toBe(500)
  })

  it('validates activityHistoryRequestSchema', () => {
    expect(activityHistoryRequestSchema.safeParse({ projectId: uuid }).success).toBe(true)
    expect(activityHistoryRequestSchema.safeParse({ projectId: 'x' }).success).toBe(false)
  })

  it('validates usageSummaryRequestSchema', () => {
    const ok = (v: unknown): boolean => usageSummaryRequestSchema.safeParse(v).success
    expect(ok({ projectId: uuid, days: 30 })).toBe(true)
    expect(ok({ projectId: null, days: 1 })).toBe(true)
    expect(ok({ projectId: null, days: 365 })).toBe(true)
    expect(ok({ projectId: null, days: 0 })).toBe(false)
    expect(ok({ projectId: null, days: 366 })).toBe(false)
    expect(ok({ projectId: null, days: 1.5 })).toBe(false)
    expect(ok({ projectId: 'nope', days: 7 })).toBe(false)
    expect(ok({ days: 7 })).toBe(false)
    expect(ok(null)).toBe(false)
  })
})
