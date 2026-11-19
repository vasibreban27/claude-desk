// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type DeskApi, type ProjectSettings } from '@shared/ipc'
import { SettingsPanel } from './SettingsPanel'
import { limitsFromSettings, validateLimits } from './LimitsEditor'

const P1 = '11111111-1111-4111-8111-111111111111'

let api: { settingsGet: ReturnType<typeof vi.fn>; settingsSet: ReturnType<typeof vi.fn>; appInfo: ReturnType<typeof vi.fn> }

function load(settings: ProjectSettings) {
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
    appInfo: vi.fn().mockResolvedValue({ toolkit: { status: 'unset', path: null, version: null } })
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

const W = 'Workers at once'
const T = 'Max turns per task'
const M = 'Time limit per task (minutes)'

describe('limits fields', () => {
  it('shows saved values', async () => {
    load({ ...defaultSettings(), maxParallel: 3, maxTurns: 50, taskTimeoutMinutes: 30 })
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByLabelText(W)).toHaveValue('3')
    expect(screen.getByLabelText(T)).toHaveValue('50')
    expect(screen.getByLabelText(M)).toHaveValue('30')
  })

  it('shows 2, 40 and 20 when absent', async () => {
    const { maxParallel, maxTurns, taskTimeoutMinutes, ...rest } = defaultSettings()
    void maxParallel
    void maxTurns
    void taskTimeoutMinutes
    load(rest)
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByLabelText(W)).toHaveValue('2')
    expect(screen.getByLabelText(T)).toHaveValue('40')
    expect(screen.getByLabelText(M)).toHaveValue('20')
  })

  it.each([
    [W, '0'],
    [W, '5'],
    [T, '4'],
    [T, '101'],
    [M, '0'],
    [M, '121'],
    [W, '1.5'],
    [T, 'abc'],
    [M, '']
  ])('rejects %s = "%s" without sending and shows its own error', async (label, value) => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent(/whole number from/)
    expect(screen.getByLabelText(label)).toHaveAccessibleDescription(/whole number from/)
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('sends the three integers with the existing fields', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText(W), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(T), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(M), { target: { value: '120' } })
    fireEvent.click(screen.getByLabelText('Allow plan writes'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet).toHaveBeenCalledWith({
      projectId: P1,
      settings: {
        ...defaultSettings(),
        allowPlanWrites: true,
        maxParallel: 4,
        maxTurns: 5,
        taskTimeoutMinutes: 120
      }
    })
  })

  it('keeps checks and limits when another setting is edited', async () => {
    load({
      ...defaultSettings(),
      maxParallel: 3,
      checks: [{ name: 'lint', executable: 'npm', args: ['run', 'lint'], timeoutMs: 60000 }]
    })
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'haiku' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    const sent = api.settingsSet.mock.calls[0]![0].settings as ProjectSettings
    expect(sent.model).toBe('haiku')
    expect(sent.maxParallel).toBe(3)
    expect(sent.checks).toEqual([{ name: 'lint', executable: 'npm', args: ['run', 'lint'], timeoutMs: 60000 }])
  })

  it('explains the hints', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText(W)
    expect(screen.getByLabelText(W)).toHaveAccessibleDescription(/cost and machine load grow.*next run/)
    expect(screen.getByText(/Use the app default, or choose a different model for Chat/)).toBeInTheDocument()
    expect(screen.getByText(/unless a project or plan task chooses another model/)).toBeInTheDocument()
  })
})

describe('limit helpers', () => {
  it('validates and converts', () => {
    expect(limitsFromSettings(defaultSettings())).toEqual({ maxParallel: '2', maxTurns: '40', taskTimeoutMinutes: '20' })
    expect(validateLimits({ maxParallel: '1', maxTurns: '5', taskTimeoutMinutes: '1' }).errors).toEqual({})
  })
})
