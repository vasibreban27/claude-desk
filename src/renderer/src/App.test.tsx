// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ChatEvent, ChatMessage, DeskApi, Project } from '@shared/ipc'
import { App } from './App'

const P1: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  path: '/a',
  name: 'alpha',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}
const P2: Project = { ...P1, id: '22222222-2222-4222-8222-222222222222', path: '/b', name: 'beta', branch: null, dirty: true }

let emit: (e: ChatEvent) => void
let api: { [K in keyof DeskApi]: ReturnType<typeof vi.fn> }

beforeEach(() => {
  api = {
    listProjects: vi.fn().mockResolvedValue([P1, P2]),
    pickAndAddProject: vi.fn(),
    refreshProject: vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
      ok: true,
      project: id === P1.id ? { ...P1, dirty: true } : P2
    })),
    chatHistory: vi.fn().mockResolvedValue([] as ChatMessage[]),
    chatSend: vi.fn().mockResolvedValue({ ok: true, turnId: 't1' }),
    onChatEvent: vi.fn().mockImplementation((l: (e: ChatEvent) => void) => {
      emit = l
      return () => undefined
    })
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

describe('projects panel', () => {
  it('lists projects with branch or detached and clean/dirty badge', async () => {
    render(<App />)
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(api.listProjects).toHaveBeenCalled()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('clean')).toBeInTheDocument()
    expect(screen.getByText('detached')).toBeInTheDocument()
    expect(screen.getByText('dirty')).toBeInTheDocument()
  })

  it('shows loading, empty and load-error states', async () => {
    api.listProjects.mockResolvedValue([])
    render(<App />)
    expect(screen.getByText(/Loading projects/)).toBeInTheDocument()
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument()
    cleanup()
    api.listProjects.mockRejectedValue(new Error('x'))
    render(<App />)
    expect(await screen.findByText('Could not load projects.')).toBeInTheDocument()
  })

  it('adds and selects a project on ok', async () => {
    api.listProjects.mockResolvedValue([])
    api.pickAndAddProject.mockResolvedValue({ ok: true, project: P1 })
    render(<App />)
    await screen.findByText(/No projects yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    const item = await screen.findByRole('button', { name: /alpha/ })
    expect(item).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })

  it('does nothing visible on cancelled', async () => {
    api.pickAndAddProject.mockResolvedValue({ ok: false, error: 'cancelled' })
    render(<App />)
    await screen.findByText('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(api.pickAndAddProject).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it.each([
    ['not-a-git-repo', /not a git repository/],
    ['duplicate', /already been added/],
    ['unreadable', /could not be read/]
  ] as const)('shows a distinct message for %s', async (error, text) => {
    api.pickAndAddProject.mockResolvedValue({ ok: false, error })
    render(<App />)
    await screen.findByText('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('refreshes status and loads history when a project is selected', async () => {
    api.chatHistory.mockResolvedValue([{ id: 'h1', role: 'user', text: 'earlier', at: '2026-01-01T00:00:00.000Z' }])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /alpha/ }))
    await waitFor(() => expect(api.refreshProject).toHaveBeenCalledWith({ id: P1.id }))
    expect(await screen.findByText('earlier')).toBeInTheDocument()
    expect(api.chatHistory).toHaveBeenCalledWith({ projectId: P1.id })
    await waitFor(() => expect(screen.getAllByText('dirty')).toHaveLength(2))
  })
})

describe('chat panel', () => {
  it('disables input with a hint when no project is selected', async () => {
    render(<App />)
    await screen.findByText('alpha')
    const input = screen.getByLabelText('Message')
    expect(input).toBeDisabled()
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/Add or select a project/))
  })

  async function selectAlpha() {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /alpha/ }))
    await screen.findByText(/No messages yet/)
  }

  it('streams text in place, disables input while busy, re-enables on done', async () => {
    await selectAlpha()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(api.chatSend).toHaveBeenCalledWith({ projectId: P1.id, text: 'hello' })
    expect(screen.getByLabelText('Message')).toBeDisabled()

    act(() => emit({ projectId: P1.id, turnId: 't1', type: 'text-delta', text: 'Hi ' }))
    act(() => emit({ projectId: P1.id, turnId: 't1', type: 'text-delta', text: 'there' }))
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(screen.getAllByText(/Claude:/)).toHaveLength(1)
    expect(screen.getByLabelText('Message')).toBeDisabled()

    act(() => emit({ projectId: P1.id, turnId: 't1', type: 'done' }))
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })

  it('shows an error event and re-enables input', async () => {
    await selectAlpha()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('hello')
    act(() => emit({ projectId: P1.id, turnId: 't1', type: 'error', message: 'Toolkit path missing' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Toolkit path missing')
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })

  it('shows a readable message when send is rejected', async () => {
    api.chatSend.mockResolvedValue({ ok: false, error: 'busy' })
    await selectAlpha()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/still answering/)
  })

  it('ignores events for another project', async () => {
    await selectAlpha()
    act(() => emit({ projectId: P2.id, turnId: 'x', type: 'text-delta', text: 'secret' }))
    expect(screen.queryByText('secret')).toBeNull()
  })
})
