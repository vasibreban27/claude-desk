// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type ChatEvent, type PipelineLogEntry, type PipelineRunView, type Project } from '@shared/ipc'
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
let emitLog: (e: PipelineLogEntry) => void = () => undefined
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
    onPipelineEvent: vi.fn().mockReturnValue(() => undefined),
    pipelineLog: vi.fn().mockResolvedValue([]),
    onPipelineLog: vi.fn().mockImplementation((l: (e: PipelineLogEntry) => void) => {
      emitLog = l
      return () => undefined
    })
  }
  ;(window as unknown as { api: unknown }).api = api
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
})

describe('new project to planner flow', () => {
  function sendInChat(text: string) {
    const input = screen.getByLabelText('Message')
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
  }

  it('starts a project from the first chat message and hands that message to the planner', async () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull()
    expect(screen.getByText(/Start a new project: describe what to build/)).toBeInTheDocument()
    sendInChat('I want a todo API in FastAPI')
    await waitFor(() =>
      expect(api['chatSend']).toHaveBeenCalledWith({ projectId: P.id, text: 'I want a todo API in FastAPI', mode: 'plan' })
    )
    expect(api['createProject']).toHaveBeenCalledWith({ name: 'todo-api-fastapi', enableCommands: true })
    expect(api['chatSend']).toHaveBeenCalledOnce()
    expect(screen.getByRole('radio', { name: 'Plan (flow:plan, Opus)' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent('I want a todo API in FastAPI')
  })

  it('numbers the name when the folder exists and asks for a projects folder once', async () => {
    api['createProject']
      ?.mockResolvedValueOnce({ ok: false, error: 'no-root' })
      .mockResolvedValueOnce({ ok: false, error: 'exists' })
      .mockResolvedValueOnce({ ok: true, project: P })
    api['projectsRootPick'] = vi.fn().mockResolvedValue({ root: '/r' })
    render(<App />)
    sendInChat('todo API')
    await waitFor(() => expect(api['chatSend']).toHaveBeenCalledOnce())
    expect(api['projectsRootPick']).toHaveBeenCalledOnce()
    expect(api['createProject']?.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['todo-api', 'todo-api', 'todo-api-2'])
  })

  it('shows an error and creates nothing when no projects folder is chosen', async () => {
    api['createProject']?.mockResolvedValue({ ok: false, error: 'no-root' })
    api['projectsRootPick'] = vi.fn().mockResolvedValue({ root: null })
    render(<App />)
    sendInChat('todo API')
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a projects folder')
    expect(api['chatSend']).not.toHaveBeenCalled()
  })

  it('Add project > New project switches the chat to a new project; selecting a project switches back', async () => {
    api['listProjects']?.mockResolvedValue([P])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^todo-fastapi/ }))
    expect(screen.getByRole('radio', { name: 'Chat (read-only)' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    fireEvent.click(screen.getByRole('button', { name: /^New project/ }))
    expect(screen.queryByRole('radiogroup', { name: 'Chat mode' })).toBeNull()
    expect(screen.getByText(/Start a new project/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^todo-fastapi/ }))
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Chat mode' })).toBeInTheDocument())
  })

  it('shows the plan-ready card and starts the pipeline on click', async () => {
    api['listProjects']?.mockResolvedValue([P])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^todo-fastapi/ }))
    await act(async () => undefined)
    act(() => emit({ projectId: P.id, turnId: 't2', type: 'plan-ready', planFile: 'todo-api.md', problem: null }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start pipeline' }))
    await waitFor(() => expect(api['pipelineStart']).toHaveBeenCalledWith({ projectId: P.id, planFile: 'todo-api.md' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Plan ready' })).toBeNull())
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the latest live pipeline line on the running task', async () => {
    api['listProjects']?.mockResolvedValue([P])
    const run: PipelineRunView = {
      runId: 'r1',
      planFile: 'todo.md',
      status: 'running',
      active: true,
      baseBranch: 'main',
      integrationBranch: 'run/r1',
      createdAt: '2026-11-18T12:00:00.000Z',
      finishedAt: null,
      tasks: [
        {
          taskId: 'T1',
          title: 'Schemas',
          wave: 1,
          status: 'running',
          reason: null,
          commit: null,
          checks: null,
          durationMs: null,
          costUsd: null,
          stage: null,
          fixRounds: null,
          findings: null
        } as PipelineRunView['tasks'][number]
      ]
    }
    api['pipelineStatus']?.mockResolvedValue({ ok: true, run })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^todo-fastapi/ }))
    await act(async () => undefined)
    const line: PipelineLogEntry = {
      projectId: P.id,
      runId: 'r1',
      seq: 0,
      at: '2026-11-18T12:00:01.000Z',
      taskId: 'T1',
      role: 'worker',
      agent: null,
      text: 'Write app/schemas.py',
      tone: 'info'
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }))
    await act(async () => undefined)
    act(() => emitLog(line))
    expect(await screen.findByLabelText('T1 latest')).toHaveTextContent('worker: Write app/schemas.py')
  })

  it('switches to the Pipeline tab when the planner starts a run from chat', async () => {
    api['listProjects']?.mockResolvedValue([P])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^todo-fastapi/ }))
    await act(async () => undefined)
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
    act(() => emit({ projectId: P.id, turnId: 't3', type: 'pipeline-started', planFile: 'todo.md', runId: 'r9' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true'))
  })
})
