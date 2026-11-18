// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ASSISTANT_PROJECT_ID, defaultSettings, type ChatEvent, type Project } from '@shared/ipc'
import { App } from './App'

afterEach(cleanup)

const P: Project = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'todo-fastapi',
  path: '/r/todo-fastapi',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}
let emit: (e: ChatEvent) => void = () => undefined
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    listProjects: vi.fn().mockResolvedValue([]),
    refreshProject: vi.fn().mockResolvedValue({ ok: true, project: P }),
    chatHistory: vi.fn().mockResolvedValue([]),
    chatSend: vi.fn().mockResolvedValue({ ok: true, turnId: 't1' }),
    onChatEvent: vi.fn().mockImplementation((l: (e: ChatEvent) => void) => {
      emit = l
      return () => undefined
    }),
    projectsRootGet: vi.fn().mockResolvedValue({ root: '/r' }),
    createProject: vi.fn().mockResolvedValue({ ok: true, project: P }),
    settingsGet: vi.fn().mockResolvedValue({ ok: true, settings: defaultSettings(), notice: null }),
    activityHistory: vi.fn().mockResolvedValue([]),
    usageSummary: vi.fn().mockReturnValue(new Promise(() => undefined)),
    appInfo: vi.fn().mockResolvedValue({ toolkit: { status: 'unset', path: null, version: null } }),
    onActivityEvent: vi.fn().mockReturnValue(() => undefined),
    pipelineStatus: vi.fn().mockReturnValue(new Promise(() => undefined)),
    pipelinePlans: vi.fn().mockResolvedValue({ ok: true, plans: [] }),
    pipelineStart: vi.fn().mockResolvedValue({ ok: true, runId: 'r1' }),
    onPipelineEvent: vi.fn().mockReturnValue(() => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
})

describe('assistant to planner flow', () => {
  it('keeps the proposal across switching, creates on click and continues in Plan mode with the brief', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))
    await act(async () => undefined)
    act(() => emit({ projectId: ASSISTANT_PROJECT_ID, turnId: 't1', type: 'proposal', name: 'todo-fastapi', brief: 'todo API in FastAPI' }))
    expect(await screen.findByRole('group', { name: 'Create project' })).toBeInTheDocument()

    // Leaving and coming back must not lose the card.
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))
    expect(screen.getByRole('group', { name: 'Create project' })).toBeInTheDocument()

    await screen.findByText('Folder: /r/todo-fastapi')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() =>
      expect(api['chatSend']).toHaveBeenCalledWith({ projectId: P.id, text: 'todo API in FastAPI', mode: 'plan' })
    )
    expect(api['createProject']).toHaveBeenCalledWith({ name: 'todo-fastapi', enableCommands: true })
    expect(await screen.findByRole('radio', { name: 'Plan (flow:plan, Opus)' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the plan-ready card and starts the pipeline on click', async () => {
    api['listProjects']?.mockResolvedValue([P])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /todo-fastapi/ }))
    await act(async () => undefined)
    act(() => emit({ projectId: P.id, turnId: 't2', type: 'plan-ready', planFile: 'todo-api.md', problem: null }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start pipeline' }))
    await waitFor(() => expect(api['pipelineStart']).toHaveBeenCalledWith({ projectId: P.id, planFile: 'todo-api.md' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Plan ready' })).toBeNull())
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true')
  })
})
