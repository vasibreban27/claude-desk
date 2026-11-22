// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from './useProjects'

const P = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'demo',
  path: '/w/demo',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}
let api: Record<string, unknown>
beforeEach(() => {
  api = { listProjects: vi.fn().mockResolvedValue([P]) }
  ;(window as unknown as { api: unknown }).api = api
})

async function hook() {
  const r = renderHook(() => useProjects())
  await waitFor(() => expect(r.result.current.projects).toHaveLength(1))
  return r
}

describe('useProjects.remove', () => {
  it('removes the project from the list on success', async () => {
    api['removeProject'] = vi.fn().mockResolvedValue({ ok: true, folderDeleted: true })
    const r = await hook()
    let err: string | null = 'x'
    await act(async () => {
      err = await r.result.current.remove(P.id, true)
    })
    expect(err).toBeNull()
    expect(r.result.current.projects).toEqual([])
  })

  it('says to restart when the main process has no handler yet (stale dev session)', async () => {
    api['removeProject'] = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'projects:remove': Error: No handler registered for 'projects:remove'"))
    const r = await hook()
    let err: string | null = null
    await act(async () => {
      err = await r.result.current.remove(P.id, false)
    })
    expect(err).toMatch(/restart Odyssey/)
    expect(r.result.current.projects).toHaveLength(1)
  })

  it('says to restart when the preload has no removeProject yet', async () => {
    const r = await hook()
    let err: string | null = null
    await act(async () => {
      err = await r.result.current.remove(P.id, false)
    })
    expect(err).toMatch(/restart Odyssey/)
  })

  it('maps error codes to readable text', async () => {
    api['removeProject'] = vi.fn().mockResolvedValue({ ok: false, error: 'not-found' })
    const r = await hook()
    let err: string | null = null
    await act(async () => {
      err = await r.result.current.remove(P.id, false)
    })
    expect(err).toMatch(/no longer registered/)
  })
})
