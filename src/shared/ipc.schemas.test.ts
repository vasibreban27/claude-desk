import { describe, expect, it } from 'vitest'
import {
  chatHistoryRequestSchema,
  chatMessageSchema,
  chatSendRequestSchema,
  projectSchema,
  projectsRefreshRequestSchema
} from './ipc'

const uuid = '2f1b6c3e-8d5a-4c1e-9b7a-3e6f1d2c4a5b'
const project = {
  id: uuid,
  path: '/repo',
  name: 'repo',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}

describe('request schema boundaries (gap coverage)', () => {
  it('accepts a 1-char text and rejects non-string text', () => {
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: 'a' }).success).toBe(true)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: null }).success).toBe(false)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: ['a'] }).success).toBe(false)
  })

  it('rejects non-object payloads and undefined', () => {
    for (const bad of [undefined, null, 'x', 5, [], true]) {
      expect(projectsRefreshRequestSchema.safeParse(bad).success).toBe(false)
      expect(chatHistoryRequestSchema.safeParse(bad).success).toBe(false)
      expect(chatSendRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects malformed uuids', () => {
    for (const id of ['', ' ' + uuid, uuid + 'x', uuid.replace(/-/g, ''), 'g'.repeat(36)]) {
      expect(projectsRefreshRequestSchema.safeParse({ id }).success).toBe(false)
    }
  })

  it('rejects wrong field names (id vs projectId)', () => {
    expect(chatHistoryRequestSchema.safeParse({ id: uuid }).success).toBe(false)
    expect(projectsRefreshRequestSchema.safeParse({ projectId: uuid }).success).toBe(false)
  })

  it('counts exactly 20000 multi-line characters', () => {
    const text = 'line\n'.repeat(4000)
    expect(text.length).toBe(20000)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text }).success).toBe(true)
    expect(chatSendRequestSchema.safeParse({ projectId: uuid, text: text + 'x' }).success).toBe(false)
  })

  it('strips unknown keys rather than passing them through', () => {
    const r = chatSendRequestSchema.safeParse({ projectId: uuid, text: 'hi', extra: 1 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ projectId: uuid, text: 'hi' })
  })
})

describe('entity schemas', () => {
  it('parses a project, including null branch (detached HEAD)', () => {
    expect(projectSchema.safeParse(project).success).toBe(true)
    expect(projectSchema.safeParse({ ...project, branch: null }).success).toBe(true)
  })

  it('rejects invalid projects', () => {
    expect(projectSchema.safeParse({ ...project, id: 'x' }).success).toBe(false)
    expect(projectSchema.safeParse({ ...project, path: '' }).success).toBe(false)
    expect(projectSchema.safeParse({ ...project, dirty: 'no' }).success).toBe(false)
    expect(projectSchema.safeParse({ ...project, addedAt: 'yesterday' }).success).toBe(false)
    expect(projectSchema.safeParse({ ...project, branch: undefined }).success).toBe(false)
  })

  it('parses and rejects chat messages', () => {
    const msg = { id: 'm1', role: 'user', text: '', at: '2026-01-01T00:00:00Z' }
    expect(chatMessageSchema.safeParse(msg).success).toBe(true)
    expect(chatMessageSchema.safeParse({ ...msg, role: 'system' }).success).toBe(false)
    expect(chatMessageSchema.safeParse({ ...msg, at: 'now' }).success).toBe(false)
  })
})
