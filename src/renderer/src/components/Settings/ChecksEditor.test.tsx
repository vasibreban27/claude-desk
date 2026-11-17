// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type AppInfo, type DeskApi, type ProjectSettings } from '@shared/ipc'
import { SettingsPanel } from './SettingsPanel'

const P1 = '11111111-1111-4111-8111-111111111111'
const INFO: AppInfo = { toolkit: { status: 'valid', path: '/tk/flow', version: '0.7.0' } }

let api: {
  settingsGet: ReturnType<typeof vi.fn>
  settingsSet: ReturnType<typeof vi.fn>
  appInfo: ReturnType<typeof vi.fn>
}

function load(settings: ProjectSettings): void {
  api.settingsGet.mockResolvedValue({ ok: true, settings, notice: null })
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

const SAVED = {
  ...defaultSettings(),
  checks: [
    { name: 'test', executable: 'npx', args: ['vitest', 'run'], timeoutMs: 120000, acceptsTestPath: true },
    { name: 'lint', executable: 'npm', args: ['run', 'lint'], timeoutMs: 30000 }
  ]
}

const group = (n: number): HTMLElement => screen.getByRole('group', { name: `Check ${n}` })
const clickSave = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

async function addValid(n: number, name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Add check' }))
  const g = group(n)
  fireEvent.change(within(g).getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(within(g).getByLabelText('Executable'), { target: { value: 'node' } })
}

describe('ChecksEditor in the settings form', () => {
  it('shows an empty list for settings without checks', async () => {
    const noChecks: Partial<ProjectSettings> = defaultSettings()
    delete noChecks.checks
    load(noChecks as ProjectSettings)
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Add check' })).toBeEnabled()
  })

  it('shows each saved check with its fields', async () => {
    load(SAVED)
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    const g1 = group(1)
    expect(within(g1).getByLabelText('Name')).toHaveValue('test')
    expect(within(g1).getByLabelText('Executable')).toHaveValue('npx')
    expect(within(g1).getByLabelText('Arguments (one per line)')).toHaveValue('vitest\nrun')
    expect(within(g1).getByLabelText('Timeout (seconds)')).toHaveValue('120')
    expect(within(g1).getByLabelText('Takes a test path')).toBeChecked()
    expect(within(group(2)).getByLabelText('Takes a test path')).not.toBeChecked()
  })

  it('adds rows up to 8, disables Add at 8, and removes a row', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    const add = screen.getByRole('button', { name: 'Add check' })
    for (let i = 0; i < 8; i++) fireEvent.click(add)
    expect(screen.getAllByRole('group')).toHaveLength(8)
    expect(add).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove check 3' }))
    expect(screen.getAllByRole('group')).toHaveLength(7)
    expect(add).toBeEnabled()
  })

  it('shows the hint about names, user, reduced environment, no shell and no sandbox', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    const hint = screen.getByText(/Workers run these by name, as you/)
    expect(hint).toHaveTextContent(/reduced environment/)
    expect(hint).toHaveTextContent(/no shell.*one argument per line/i)
    expect(hint).toHaveTextContent(/not a sandbox/)
  })

  it('sends valid rows with timeout in milliseconds and acceptsTestPath only when ticked', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    await addValid(1, 'unit')
    fireEvent.change(within(group(1)).getByLabelText('Arguments (one per line)'), {
      target: { value: 'run\n\n--flag=a b\r\n' }
    })
    fireEvent.change(within(group(1)).getByLabelText('Timeout (seconds)'), { target: { value: '90' } })
    fireEvent.click(within(group(1)).getByLabelText('Takes a test path'))
    await addValid(2, 'lint')
    clickSave()
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet).toHaveBeenCalledTimes(1)
    const sent = api.settingsSet.mock.calls[0]![0].settings
    expect(sent.checks).toEqual([
      { name: 'unit', executable: 'node', args: ['run', '--flag=a b'], timeoutMs: 90000, acceptsTestPath: true },
      { name: 'lint', executable: 'node', args: [], timeoutMs: 60000 }
    ])
    expect(sent.model).toBe('auto')
    expect(sent.allowGitRead).toBe(false)
  })

  it.each([
    ['name', 'Name', 'Bad Name', /Name must be/],
    ['executable', 'Executable', '', /Executable is required/],
    ['timeout low', 'Timeout (seconds)', '0', /between 1 and 600/],
    ['timeout high', 'Timeout (seconds)', '601', /between 1 and 600/],
    ['timeout text', 'Timeout (seconds)', 'abc', /between 1 and 600/],
    ['args', 'Arguments (one per line)', Array.from({ length: 17 }, (_v, i) => `a${i}`).join('\n'), /At most 16/]
  ])('blocks save and marks the row for invalid %s', async (_n, label, value, message) => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    await addValid(1, 'ok')
    fireEvent.change(within(group(1)).getByLabelText(label), { target: { value } })
    clickSave()
    expect(await within(group(1)).findByText(message)).toBeInTheDocument()
    expect(within(group(1)).getByLabelText(label)).toHaveAttribute('aria-invalid', 'true')
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('blocks save for duplicate names and marks the second row', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    await addValid(1, 'same')
    await addValid(2, 'same')
    clickSave()
    expect(await within(group(2)).findByText(/must be unique/)).toBeInTheDocument()
    expect(within(group(1)).queryByText(/must be unique/)).toBeNull()
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('preserves saved checks when another setting is edited and saved', async () => {
    load(SAVED)
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'opus' } })
    clickSave()
    await screen.findByText(/Settings saved/)
    const sent = api.settingsSet.mock.calls[0]![0].settings
    expect(sent.model).toBe('opus')
    expect(sent.checks).toEqual(SAVED.checks)
  })

  it('sends an empty list when all checks are removed', async () => {
    load(SAVED)
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    fireEvent.click(screen.getByRole('button', { name: 'Remove check 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove check 1' }))
    clickSave()
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet.mock.calls[0]![0].settings.checks).toEqual([])
  })
})
