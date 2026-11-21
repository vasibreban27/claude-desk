// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { defaultSettings, type DeskApi, type ProjectSettings } from '@shared/ipc'
import { SettingsPanel } from './SettingsPanel'
import { validateReview } from './ReviewEditor'

const P1 = '11111111-1111-4111-8111-111111111111'

let api: { settingsGet: ReturnType<typeof vi.fn>; settingsSet: ReturnType<typeof vi.fn>; appInfo: ReturnType<typeof vi.fn>; toolkitStatus?: ReturnType<typeof vi.fn> }

beforeEach(() => {
  api = {
    settingsGet: vi.fn().mockResolvedValue({ ok: true, settings: defaultSettings(), notice: null }),
    settingsSet: vi.fn().mockImplementation(async ({ settings }: { settings: ProjectSettings }) => ({
      ok: true,
      settings,
      sessionReset: false
    })),
    toolkitStatus: vi.fn(async () => ({ ...(await (api.appInfo as unknown as () => Promise<{ toolkit: object }>)()).toolkit, source: 'environment', git: null })),
    appInfo: vi.fn().mockResolvedValue({ toolkit: { status: 'unset', path: null, version: null } })
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

const R = 'Fix rounds'

describe('review settings', () => {
  it('shows the defaults', async () => {
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByLabelText(R)).toHaveValue('2')
    expect(screen.getByLabelText('Reviewer')).toBeChecked()
    expect(screen.getByLabelText('Security auditor')).not.toBeChecked()
  })

  it('sends rounds and reviewers with every other setting unchanged', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText(R), { target: { value: '3' } })
    fireEvent.click(screen.getByLabelText('Security auditor'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet).toHaveBeenCalledWith({
      projectId: P1,
      settings: { ...defaultSettings(), autoFixRounds: 3, reviewers: ['reviewer', 'security-auditor'] }
    })
  })

  it('allows no reviewer and 0 rounds', async () => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText(R), { target: { value: '0' } })
    fireEvent.click(screen.getByLabelText('Reviewer'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Settings saved/)
    const sent = api.settingsSet.mock.calls[0]![0].settings as ProjectSettings
    expect(sent.autoFixRounds).toBe(0)
    expect(sent.reviewers).toEqual([])
  })

  it.each(['6', '-1', '1.5', 'abc', ''])('disables Save with a message for "%s"', async (value) => {
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText(R), { target: { value } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 0 to 5.')
    expect(screen.getByLabelText(R)).toHaveAccessibleDescription(/whole number from 0 to 5/)
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('says the changes apply to the next message or run', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText(R)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/next message or run/)).toBeInTheDocument()
  })

  it('validateReview orders reviewers and flags bad rounds', () => {
    expect(validateReview({ autoFixRounds: '5', reviewers: ['security-auditor', 'reviewer'] })).toEqual({
      values: { autoFixRounds: 5, reviewers: ['reviewer', 'security-auditor'] },
      error: null
    })
    expect(validateReview({ autoFixRounds: '9', reviewers: [] }).error).not.toBeNull()
  })
})
