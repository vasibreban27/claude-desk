import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_BUFFER_MAX,
  CHAT_TEXT_MAX,
  IPC,
  activityHistoryRequestSchema,
  chatHistoryRequestSchema,
  chatSendRequestSchema,
  projectsRefreshRequestSchema,
  usageSummaryRequestSchema
} from './ipc'

const uuid = '2f1b6c3e-8d5a-4c1e-9b7a-3e6f1d2c4a5b'

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
        'usage:summary'
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
