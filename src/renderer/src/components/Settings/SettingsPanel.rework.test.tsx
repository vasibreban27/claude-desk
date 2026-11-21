// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type DeskApi, type ProjectSettings, type ToolkitStatus } from '@shared/ipc'
import { SettingsPanel, effectiveModelText } from './SettingsPanel'

const P1 = '11111111-1111-4111-8111-111111111111'

const STATUS: ToolkitStatus = {
  status: 'valid',
  path: 'C:/work/claude-toolkit/plugins/flow',
  version: '0.11.0',
  source: 'environment',
  git: { branch: 'main', commit: 'abc1234', date: '2026-11-20', subject: 'feat: java conventions', dirty: false }
}

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    settingsGet: vi.fn().mockResolvedValue({ ok: true, settings: defaultSettings(), notice: null }),
    settingsSet: vi.fn().mockImplementation(async ({ settings }: { settings: ProjectSettings }) => ({ ok: true, settings, sessionReset: false })),
    toolkitStatus: vi.fn().mockResolvedValue(STATUS),
    appInfo: vi.fn().mockResolvedValue({ toolkit: { status: 'valid', path: STATUS.path, version: STATUS.version } }),
    toolkitPick: vi.fn(),
    toolkitUpdate: vi.fn(),
    appModelGet: vi.fn().mockResolvedValue({ model: 'sonnet' }),
    appModelSet: vi.fn().mockImplementation(async ({ model }) => ({ ok: true, model })),
    projectsRootGet: vi.fn().mockResolvedValue({ root: null }),
    settingsSuggestions: vi.fn().mockResolvedValue([])
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

const project = () => screen.findByRole('form', { name: 'Project settings' })

describe('Settings rework: quality first', () => {
  it('warns when there are no checks and adds one from the common list', async () => {
    render(<SettingsPanel projectId={P1} />)
    await project()
    expect(screen.getByText(/No checks yet: tasks are reviewed but never tested/)).toBeInTheDocument()
    const pick = screen.getByLabelText('Add a common check')
    expect(within(pick).getByRole('group', { name: 'Java (Maven)' })).toBeInTheDocument()
    fireEvent.change(pick, { target: { value: 'maven-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.queryByText(/No checks yet/)).toBeNull()
    expect(screen.getByLabelText('Name')).toHaveValue('maven-test')
    expect(within(pick).getByRole('option', { name: /mvn -q test/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api['settingsSet']).toHaveBeenCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ checks: [{ name: 'maven-test', executable: 'mvn', args: ['-q', 'test'], timeoutMs: 300000 }] }) })
      )
    )
  })

  it('puts the Quality card first and open, the others collapsed with a summary', async () => {
    render(<SettingsPanel projectId={P1} />)
    const form = await project()
    const cards = form.querySelectorAll('details')
    expect([...cards].map((c) => c.querySelector('.settings__card-title')?.textContent)).toEqual([
      'Quality',
      'Pipeline',
      'After a run',
      'Chat and models',
      'Safety'
    ])
    expect(cards[0]).toHaveAttribute('open')
    expect(cards[1]).not.toHaveAttribute('open')
    expect(cards[0]?.querySelector('.settings__card-summary')).toHaveTextContent('No checks · 1 reviewer')
    expect(cards[4]?.querySelector('.settings__card-summary')).toHaveTextContent(/protected patterns/)
  })
})

describe('Settings rework: unsaved changes', () => {
  it('shows the state in the save bar and discards edits', async () => {
    render(<SettingsPanel projectId={P1} />)
    await project()
    const bar = screen.getByRole('region', { name: 'Save project settings' })
    expect(bar).toHaveTextContent('No unsaved changes.')
    expect(within(bar).queryByRole('button', { name: 'Discard' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Allow read-only git'))
    expect(bar).toHaveTextContent('You have unsaved changes.')
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByLabelText('Allow read-only git')).not.toBeChecked())
    expect(screen.getByRole('region', { name: 'Save project settings' })).toHaveTextContent('No unsaved changes.')
    expect(api['settingsSet']).not.toHaveBeenCalled()
  })
})

describe('Settings rework: models', () => {
  it('explains the effective model', () => {
    expect(effectiveModelText('opus', 'sonnet')).toBe('Opus (set for this project)')
    expect(effectiveModelText('auto', 'sonnet')).toBe('Sonnet (the app default)')
    expect(effectiveModelText('auto', 'auto')).toMatch(/Claude Code's default/)
  })

  it('shows it next to the project model, follows the app model and links to the Toolkit tab', async () => {
    const open = vi.fn()
    render(<SettingsPanel projectId={P1} onOpenToolkit={open} />)
    await project()
    await waitFor(() => expect(screen.getByText(/Effective: Sonnet \(the app default\)/)).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('region', { name: 'App' })).getByLabelText('Default model'), { target: { value: 'haiku' } })
    expect(screen.getByText(/Effective: Haiku \(the app default\)/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } })
    expect(screen.getByText(/Effective: Opus \(set for this project\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toolkit tab' }))
    expect(open).toHaveBeenCalled()
  })
})

describe('Settings rework: toolkit folder', () => {
  it('shows the folder, its source and git state', async () => {
    render(<SettingsPanel projectId={null} />)
    const tk = await screen.findByRole('region', { name: 'Toolkit folder' })
    expect(await within(tk).findByText(STATUS.path as string)).toBeInTheDocument()
    expect(within(tk).getByText('from CLAUDE_TOOLKIT_PATH')).toBeInTheDocument()
    expect(within(tk).getByText('Valid')).toBeInTheDocument()
    expect(within(tk).getByText(/main · abc1234 · 2026-11-20/)).toBeInTheDocument()
  })

  it('chooses a folder and reports a folder that is not a toolkit', async () => {
    api['toolkitPick']!
      .mockResolvedValueOnce({ ok: false, error: 'not-a-toolkit', message: 'That folder has no toolkit plugin.' })
      .mockResolvedValueOnce({ ok: true, status: { ...STATUS, source: 'settings' } })
      .mockResolvedValueOnce({ ok: false, error: 'cancelled' })
    render(<SettingsPanel projectId={null} />)
    const tk = await screen.findByRole('region', { name: 'Toolkit folder' })
    await within(tk).findByText('Valid')
    fireEvent.click(within(tk).getByRole('button', { name: 'Choose folder…' }))
    expect(await within(tk).findByRole('alert')).toHaveTextContent('That folder has no toolkit plugin.')
    fireEvent.click(within(tk).getByRole('button', { name: 'Choose folder…' }))
    expect(await within(tk).findByText('chosen here')).toBeInTheDocument()
    expect(within(tk).getByText(/Toolkit folder saved/)).toBeInTheDocument()
    fireEvent.click(within(tk).getByRole('button', { name: 'Choose folder…' }))
    await waitFor(() => expect(api['toolkitPick']).toHaveBeenCalledTimes(3))
    expect(within(tk).queryByRole('alert')).toBeNull()
  })

  it('updates the toolkit, and cannot update with uncommitted changes', async () => {
    api['toolkitUpdate']!.mockResolvedValueOnce({ ok: true, updated: true, from: 'abc1234', to: 'def5678' })
    render(<SettingsPanel projectId={null} />)
    const tk = await screen.findByRole('region', { name: 'Toolkit folder' })
    fireEvent.click(await within(tk).findByRole('button', { name: 'Update (git pull)' }))
    expect(await within(tk).findByText('Updated from abc1234 to def5678.')).toBeInTheDocument()
    cleanup()
    api['toolkitStatus']!.mockResolvedValue({ ...STATUS, git: { ...STATUS.git!, dirty: true } })
    render(<SettingsPanel projectId={null} />)
    const dirty = await screen.findByRole('region', { name: 'Toolkit folder' })
    expect(await within(dirty).findByRole('button', { name: 'Update (git pull)' })).toBeDisabled()
    expect(within(dirty).getByText(/uncommitted changes/)).toBeInTheDocument()
  })

  it('explains an unset toolkit', async () => {
    api['toolkitStatus']!.mockResolvedValue({ status: 'unset', path: null, version: null, source: 'unset', git: null })
    render(<SettingsPanel projectId={null} />)
    const tk = await screen.findByRole('region', { name: 'Toolkit folder' })
    expect(await within(tk).findByText(/Choose your claude-toolkit clone; the app finds the plugin inside it/)).toBeInTheDocument()
    expect(within(tk).queryByRole('button', { name: 'Update (git pull)' })).toBeNull()
  })
})
