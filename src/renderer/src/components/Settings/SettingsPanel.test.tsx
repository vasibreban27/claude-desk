// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type AppInfo, type DeskApi, type ProjectSettings } from '@shared/ipc'
import { Workspace } from '../Workspace'
import { SettingsPanel } from './SettingsPanel'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const INFO: AppInfo = { toolkit: { status: 'valid', path: '/tk/flow', version: '0.7.0' } }

let api: {
  settingsGet: ReturnType<typeof vi.fn>
  settingsSet: ReturnType<typeof vi.fn>
  appInfo: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  api = {
    settingsGet: vi.fn().mockResolvedValue({ ok: true, settings: defaultSettings(), notice: null }),
    settingsSet: vi.fn().mockImplementation(async ({ settings }: { settings: ProjectSettings }) => ({
      ok: true,
      settings,
      sessionReset: false
    })),
    appInfo: vi.fn().mockResolvedValue(INFO)
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

describe('SettingsPanel', () => {
  it('loads and shows model, paths, both toggles off, hints and Save', async () => {
    render(<SettingsPanel projectId={P1} />)
    expect(screen.getByText(/Loading settings/)).toBeInTheDocument()
    const model = await screen.findByLabelText('Model')
    expect(api.settingsGet).toHaveBeenCalledWith({ projectId: P1 })
    expect(model).toHaveValue('auto')
    expect(Array.from((model as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      'Auto',
      'Haiku',
      'Sonnet',
      'Opus'
    ])
    expect(screen.getByLabelText('Protected paths')).toHaveValue(defaultSettings().protectedPaths.join('\n'))
    expect(screen.getByLabelText('Allow read-only git')).not.toBeChecked()
    expect(screen.getByLabelText('Allow plan writes')).not.toBeChecked()
    expect(screen.getByText(/no shell access/)).toBeInTheDocument()
    expect(screen.getByText(/docs\/plans/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('states that search tools are best-effort', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    expect(
      screen.getByText(/Search tools are best-effort: Grep excludes matching files, but Glob can still list their names\./)
    ).toBeInTheDocument()
  })

  it('saves the parsed object once and shows the saved values', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Protected paths'), { target: { value: 'a.txt\r\n\n  \nsecret/\n' } })
    fireEvent.click(screen.getByLabelText('Allow read-only git'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet).toHaveBeenCalledTimes(1)
    expect(api.settingsSet).toHaveBeenCalledWith({
      projectId: P1,
      settings: {
        version: 1,
        model: 'opus',
        protectedPaths: ['a.txt', 'secret/'],
        allowGitRead: true,
        allowPlanWrites: false
      }
    })
    expect(screen.getByLabelText('Model')).toHaveValue('opus')
    expect(screen.getByLabelText('Protected paths')).toHaveValue('a.txt\nsecret/')
    expect(screen.getByLabelText('Allow read-only git')).toBeChecked()
    expect(screen.queryByText(/starts a new session/)).toBeNull()
  })

  it('allows an empty protected-paths list', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Protected paths'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet.mock.calls[0]![0].settings.protectedPaths).toEqual([])
  })

  it('shows the session-reset message when sessionReset is true', async () => {
    api.settingsSet.mockImplementation(async ({ settings }: { settings: ProjectSettings }) => ({
      ok: true,
      settings,
      sessionReset: true
    }))
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/next message starts a new session and loses conversation context/)).toBeInTheDocument()
  })

  it.each([
    ['invalid', /rejected as invalid/],
    ['storage-unavailable', /storage is unavailable/],
    ['not-found', /no longer exists/]
  ] as const)('shows an error for %s and keeps the form values', async (error, text) => {
    api.settingsSet.mockResolvedValue({ ok: false, error })
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'haiku' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.getByLabelText('Model')).toHaveValue('haiku')
    expect(screen.queryByText(/Settings saved/)).toBeNull()
  })

  it('shows an error when the call rejects', async () => {
    api.settingsSet.mockRejectedValue(new Error('x'))
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/)
  })

  it('does not call the API for too-long patterns and shows an error', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Protected paths'), { target: { value: 'x'.repeat(201) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid/)
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('disables Save while pending and prevents a double submit', async () => {
    let resolve: (v: unknown) => void = () => {}
    api.settingsSet.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    const form = screen.getByRole('form', { name: 'Project settings' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled()
    fireEvent.submit(form)
    expect(api.settingsSet).toHaveBeenCalledTimes(1)
    resolve({ ok: true, settings: defaultSettings(), sessionReset: false })
    await screen.findByText(/Settings saved/)
  })

  it.each([
    ['defaults-applied', /Stored settings were unreadable. Safe defaults are in use/],
    ['storage-unavailable', /storage is unavailable. Safe defaults are in use/]
  ] as const)('shows a banner for notice %s', async (notice, text) => {
    api.settingsGet.mockResolvedValue({ ok: true, settings: defaultSettings(), notice })
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('shows a load error', async () => {
    api.settingsGet.mockRejectedValue(new Error('x'))
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText('Could not load settings.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Model')).toBeNull()
  })

  it('shows an empty state and does not call settings:get without a project', async () => {
    render(<SettingsPanel projectId={null} />)
    expect(screen.getByText(/Select a project/)).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 10))
    expect(api.settingsGet).not.toHaveBeenCalled()
  })

  it('never shows the previous project values after switching', async () => {
    let resolveSecond: (v: unknown) => void = () => {}
    api.settingsGet.mockImplementation(({ projectId }: { projectId: string }) =>
      projectId === P1
        ? Promise.resolve({ ok: true, settings: { ...defaultSettings(), model: 'opus' }, notice: null })
        : new Promise((r) => (resolveSecond = r))
    )
    const { rerender } = render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByLabelText('Model')).toHaveValue('opus')
    rerender(<SettingsPanel projectId={P2} />)
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(screen.getByText(/Loading settings/)).toBeInTheDocument()
    resolveSecond({ ok: true, settings: { ...defaultSettings(), model: 'haiku' }, notice: null })
    expect(await screen.findByLabelText('Model')).toHaveValue('haiku')
    expect(api.settingsGet).toHaveBeenLastCalledWith({ projectId: P2 })
  })

  it('shows the App section with path, status and version', async () => {
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText('/tk/flow')).toBeInTheDocument()
    expect(screen.getByText('Valid')).toBeInTheDocument()
    expect(screen.getByText('0.7.0')).toBeInTheDocument()
  })

  it.each([
    ['invalid', { status: 'invalid', path: '/bad', version: null }, 'Invalid'],
    ['unset', { status: 'unset', path: null, version: null }, 'Not set']
  ] as const)('shows the App section for toolkit %s', async (_n, toolkit, label) => {
    api.appInfo.mockResolvedValue({ toolkit })
    render(<SettingsPanel projectId={P1} />)
    expect((await screen.findAllByText(label, { selector: 'dd' })).length).toBeGreaterThan(0)
    expect(screen.queryByText('Plugin version')).toBeNull()
  })

  it('shows an app info error', async () => {
    api.appInfo.mockRejectedValue(new Error('x'))
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText('Could not load app information.')).toBeInTheDocument()
  })
})

describe('Workspace settings tab', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.assign(api, {
      activityHistory: vi.fn().mockResolvedValue([]),
      onActivityEvent: vi.fn().mockReturnValue(() => undefined),
      usageSummary: vi.fn().mockReturnValue(new Promise(() => undefined))
    })
  })

  it('adds a third Settings tab with the same keyboard pattern and stores the key', async () => {
    render(<Workspace projectId={P1} />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Activity', 'Usage', 'Settings'])
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Activity' }), { key: 'End' })
    const settings = screen.getByRole('tab', { name: 'Settings' })
    expect(settings).toHaveAttribute('aria-selected', 'true')
    expect(settings).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id)
    expect(settings).toHaveFocus()
    expect(localStorage.getItem('claude-desk:workspace-tab')).toBe('settings')
    await waitFor(() => expect(api.settingsGet).toHaveBeenCalledWith({ projectId: P1 }))
    fireEvent.keyDown(settings, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
  })

  it('restores the stored settings tab', async () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByLabelText('Model')).toBeInTheDocument()
  })
})
