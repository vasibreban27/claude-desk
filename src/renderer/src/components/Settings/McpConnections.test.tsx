// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { McpConnection } from '@shared/ipc'
import { McpConnections } from './McpConnections'

afterEach(cleanup)

const ID = '00000000-0000-4000-8000-000000000001'
const conn = (over: Partial<McpConnection> = {}): McpConnection => ({
  id: ID,
  name: 'linear',
  transport: 'http',
  command: null,
  args: [],
  url: 'https://mcp.linear.app/mcp',
  secretKeys: ['Authorization'],
  enabled: true,
  knownTools: [],
  allowedTools: [],
  ...over
})
const tools = [
  { name: 'list_issues', description: 'List issues', readOnly: true },
  { name: 'create_issue', description: null, readOnly: false }
]

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = {
    mcpList: vi.fn().mockResolvedValue({ ok: true, connections: [], secretsAvailable: true }),
    mcpSave: vi.fn(),
    mcpDelete: vi.fn().mockResolvedValue({ ok: true }),
    mcpTest: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = api
})

describe('McpConnections', () => {
  it('adds Linear from the preset with the token as a hidden header, then tests it', async () => {
    const saved = conn()
    api['mcpSave']?.mockResolvedValue({ ok: true, connection: saved })
    api['mcpTest']?.mockResolvedValue({ ok: true, status: 'connected', tools, error: null, connection: { ...saved, knownTools: tools } })
    render(<McpConnections />)
    expect(await screen.findByText('No connections yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Linear' }))
    const form = screen.getByRole('form', { name: 'New connection' })
    expect(within(form).getByLabelText('URL')).toHaveValue('https://mcp.linear.app/mcp')
    const value = within(form).getByLabelText('Authorization value')
    expect(value).toHaveAttribute('type', 'password')
    fireEvent.change(value, { target: { value: 'Bearer lin_api_x' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api['mcpSave']).toHaveBeenCalledWith({
        id: null,
        name: 'linear',
        transport: 'http',
        command: null,
        args: [],
        url: 'https://mcp.linear.app/mcp',
        enabled: true,
        allowedTools: [],
        secrets: { Authorization: 'Bearer lin_api_x' }
      })
    )
    expect(await screen.findByText(/Connected: 2 tools/)).toBeInTheDocument()
    expect(api['mcpTest']).toHaveBeenCalledWith({ id: ID })
    expect(screen.getByText('0 of 2 tools allowed')).toBeInTheDocument()
  })

  it('validates the name before saving', async () => {
    render(<McpConnections />)
    await screen.findByText('No connections yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Local command' }))
    const form = screen.getByRole('form', { name: 'New connection' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'git' } })
    expect(within(form).getByText('This name is used by the app itself.')).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'My Server' } })
    expect(within(form).getByText(/a lowercase letter first/)).toBeInTheDocument()
  })

  it('lets the user tick tools, keeps saved secrets unless replaced, and saves', async () => {
    const c = conn({ knownTools: tools, allowedTools: [] })
    api['mcpList']?.mockResolvedValue({ ok: true, connections: [c], secretsAvailable: true })
    api['mcpSave']?.mockResolvedValue({ ok: true, connection: { ...c, allowedTools: ['list_issues'] } })
    render(<McpConnections />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit linear' })
    expect(within(form).getByLabelText('Authorization value')).toHaveAttribute('placeholder', 'saved, enter to replace')
    expect(within(form).getByText('can change data')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Only read-only' }))
    expect(within(form).getByRole('checkbox', { name: /list_issues/ })).toBeChecked()
    expect(within(form).getByRole('checkbox', { name: /create_issue/ })).not.toBeChecked()
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api['mcpSave']).toHaveBeenCalledWith(expect.objectContaining({ id: ID, allowedTools: ['list_issues'], secrets: {} })))
    expect(await screen.findByText('1 of 2 tools allowed')).toBeInTheDocument()
  })

  it('shows test failures, save errors and a missing keychain', async () => {
    api['mcpList']?.mockResolvedValue({ ok: true, connections: [conn()], secretsAvailable: false })
    api['mcpTest']?.mockResolvedValue({ ok: true, status: 'needs-auth', tools: [], error: 'the server needs a sign-in or token', connection: conn() })
    render(<McpConnections />)
    expect(await screen.findByText(/keychain is not available/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Needs a sign-in or token: the server needs a sign-in or token')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    api['mcpSave']?.mockResolvedValue({ ok: false, error: 'secrets-unavailable' })
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit linear' })).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('OS keychain is not available')
  })

  it('removes a connection after confirmation', async () => {
    api['mcpList']?.mockResolvedValue({ ok: true, connections: [conn()], secretsAvailable: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<McpConnections />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(api['mcpDelete']).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api['mcpDelete']).toHaveBeenCalledWith({ id: ID }))
    expect(await screen.findByText('No connections yet.')).toBeInTheDocument()
    confirm.mockRestore()
  })
})
