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

const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

describe('Settings gaps: error display and kept form values', () => {
  it('keeps every field, including raw path text, after a failed save', async () => {
    api.settingsSet.mockResolvedValue({ ok: false, error: 'storage-unavailable' })
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.change(screen.getByLabelText('Protected paths'), { target: { value: 'a\n\nb  \n' } })
    fireEvent.click(screen.getByLabelText('Allow read-only git'))
    fireEvent.click(screen.getByLabelText('Allow plan writes'))
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(/storage is unavailable/)
    expect(screen.getByLabelText('Model')).toHaveValue('sonnet')
    expect(screen.getByLabelText('Protected paths')).toHaveValue('a\n\nb  \n')
    expect(screen.getByLabelText('Allow read-only git')).toBeChecked()
    expect(screen.getByLabelText('Allow plan writes')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.queryByText(/starts a new session/)).toBeNull()
  })

  it('a retry after a failed save sends the kept values and clears the error', async () => {
    api.settingsSet.mockResolvedValueOnce({ ok: false, error: 'invalid' })
    render(<SettingsPanel projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'opus' } })
    save()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    save()
    await screen.findByText(/Settings saved/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.settingsSet).toHaveBeenCalledTimes(2)
    expect(api.settingsSet.mock.calls[1]![0].settings.model).toBe('opus')
  })

  it('editing any field hides a previous error', async () => {
    api.settingsSet.mockResolvedValue({ ok: false, error: 'not-found' })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/)
    fireEvent.click(screen.getByLabelText('Allow plan writes'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the bridge-unavailable error when window.api disappears before saving', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    // @ts-expect-error simulate a missing bridge
    delete window.api
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(/desktop bridge is unavailable/)
    expect(screen.getByLabelText('Model')).toBeInTheDocument()
  })

  it('a client-side validation error is shown, keeps the text and clears once the input is fixed', async () => {
    render(<SettingsPanel projectId={P1} />)
    const paths = await screen.findByLabelText('Protected paths')
    fireEvent.change(paths, { target: { value: 'x'.repeat(201) } })
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(/at most 100 lines, 200 characters/)
    expect(paths).toHaveValue('x'.repeat(201))
    fireEvent.change(paths, { target: { value: 'x'.repeat(200) } })
    save()
    await screen.findByText(/Settings saved/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.settingsSet).toHaveBeenCalledTimes(1)
  })

  it('accepts exactly 100 lines and rejects 101 on the client', async () => {
    render(<SettingsPanel projectId={P1} />)
    const paths = await screen.findByLabelText('Protected paths')
    fireEvent.change(paths, { target: { value: Array.from({ length: 101 }, (_v, i) => `p${i}`).join('\n') } })
    save()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(api.settingsSet).not.toHaveBeenCalled()
    fireEvent.change(paths, { target: { value: Array.from({ length: 100 }, (_v, i) => `p${i}`).join('\n') } })
    save()
    await screen.findByText(/Settings saved/)
    expect(api.settingsSet.mock.calls[0]![0].settings.protectedPaths).toHaveLength(100)
  })

  it('a rejected save after a successful one replaces the saved message with the error', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    await screen.findByText(/Settings saved/)
    api.settingsSet.mockResolvedValueOnce({ ok: false, error: 'invalid' })
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected as invalid/)
    expect(screen.queryByText(/Settings saved/)).toBeNull()
  })

  it('does not show the session-reset message together with an error', async () => {
    api.settingsSet.mockResolvedValueOnce({ ok: true, settings: defaultSettings(), sessionReset: true })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    await screen.findByText(/starts a new session/)
    api.settingsSet.mockResolvedValueOnce({ ok: false, error: 'storage-unavailable' })
    save()
    await screen.findByRole('alert')
    expect(screen.queryByText(/starts a new session/)).toBeNull()
    expect(screen.queryByText(/Settings saved/)).toBeNull()
  })

  it('editing hides the session-reset message too', async () => {
    api.settingsSet.mockResolvedValueOnce({ ok: true, settings: defaultSettings(), sessionReset: true })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    await screen.findByText(/starts a new session/)
    fireEvent.change(screen.getByLabelText('Protected paths'), { target: { value: 'z' } })
    expect(screen.queryByText(/starts a new session/)).toBeNull()
  })

  it('the error uses an alert role and the saved message a status role', async () => {
    api.settingsSet.mockResolvedValueOnce({ ok: false, error: 'invalid' })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    save()
    expect(await screen.findByText(/Settings saved/)).toHaveAttribute('role', 'status')
  })

  it('an error in project A is not shown in project B', async () => {
    api.settingsSet.mockResolvedValue({ ok: false, error: 'invalid' })
    const { rerender } = render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    await screen.findByRole('alert')
    rerender(<SettingsPanel projectId={P2} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a late failure for a project that was left does not show up in the new project', async () => {
    let rejectA: (e: Error) => void = () => {}
    api.settingsSet.mockReturnValueOnce(new Promise((_r, rej) => (rejectA = rej)))
    const { rerender } = render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    save()
    await screen.findByRole('button', { name: 'Saving...' })
    rerender(<SettingsPanel projectId={P2} />)
    await screen.findByLabelText('Model')
    rejectA(new Error('late'))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Settings gaps: notice banners and load states', () => {
  it('shows the stored-unreadable banner together with the default values in the form', async () => {
    api.settingsGet.mockResolvedValue({ ok: true, settings: defaultSettings(), notice: 'defaults-applied' })
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText(/Stored settings were unreadable/)).toHaveAttribute('role', 'status')
    expect(screen.getByLabelText('Model')).toHaveValue('auto')
    expect(screen.getByLabelText('Protected paths')).toHaveValue(defaultSettings().protectedPaths.join('\n'))
  })

  it('the banner disappears after a successful save', async () => {
    api.settingsGet.mockResolvedValue({ ok: true, settings: defaultSettings(), notice: 'defaults-applied' })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByText(/Stored settings were unreadable/)
    save()
    await screen.findByText(/Settings saved/)
    expect(screen.queryByText(/Stored settings were unreadable/)).toBeNull()
  })

  it('the banner stays after a failed save', async () => {
    api.settingsGet.mockResolvedValue({ ok: true, settings: defaultSettings(), notice: 'storage-unavailable' })
    api.settingsSet.mockResolvedValue({ ok: false, error: 'storage-unavailable' })
    render(<SettingsPanel projectId={P1} />)
    await screen.findByText(/Settings storage is unavailable/)
    save()
    await screen.findByRole('alert')
    expect(screen.getByText(/Settings storage is unavailable/)).toBeInTheDocument()
  })

  it('shows no banner when the notice is null', async () => {
    render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByText(/Safe defaults are in use/)).toBeNull()
  })

  it('a banner for project A is not shown for project B', async () => {
    api.settingsGet.mockImplementation(async ({ projectId }: { projectId: string }) => ({
      ok: true,
      settings: defaultSettings(),
      notice: projectId === P1 ? 'defaults-applied' : null
    }))
    const { rerender } = render(<SettingsPanel projectId={P1} />)
    await screen.findByText(/Stored settings were unreadable/)
    rerender(<SettingsPanel projectId={P2} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByText(/Stored settings were unreadable/)).toBeNull()
  })

  it('shows a not-found message when the project is unknown to the main process', async () => {
    api.settingsGet.mockResolvedValue({ ok: false, error: 'not-found' })
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This project was not found.')
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('shows a bridge error when window.api is missing, and still the App section error', async () => {
    // @ts-expect-error simulate a missing bridge
    delete window.api
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText('The desktop bridge is unavailable.')).toBeInTheDocument()
    expect(await screen.findByText('Could not load app information.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Model')).toBeNull()
  })

  it('a load error does not hide the App section', async () => {
    api.settingsGet.mockRejectedValue(new Error('x'))
    render(<SettingsPanel projectId={P1} />)
    expect(await screen.findByText('Could not load settings.')).toBeInTheDocument()
    expect(await screen.findByText('/tk/flow')).toBeInTheDocument()
  })

  it('a load error for one project clears when switching to a loadable one', async () => {
    api.settingsGet.mockImplementation(({ projectId }: { projectId: string }) =>
      projectId === P1
        ? Promise.reject(new Error('x'))
        : Promise.resolve({ ok: true, settings: defaultSettings(), notice: null })
    )
    const { rerender } = render(<SettingsPanel projectId={P1} />)
    await screen.findByText('Could not load settings.')
    rerender(<SettingsPanel projectId={P2} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByText('Could not load settings.')).toBeNull()
  })

  it('App section: unset toolkit shows "Not set" for the path and no version row', async () => {
    api.appInfo.mockResolvedValue({ toolkit: { status: 'unset', path: null, version: null } })
    render(<SettingsPanel projectId={P1} />)
    expect((await screen.findAllByText('Not set', { selector: 'dd' })).length).toBe(2)
  })

  it('re-selecting the same project after unmount loads again from the main process', async () => {
    const first = render(<SettingsPanel projectId={P1} />)
    await screen.findByLabelText('Model')
    first.unmount()
    api.settingsGet.mockResolvedValue({
      ok: true,
      settings: { ...defaultSettings(), model: 'haiku' },
      notice: null
    })
    render(<SettingsPanel projectId={P1} />)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('haiku'))
  })
})

describe('Settings gaps: keyboard on the Settings tab', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.assign(api, {
      activityHistory: vi.fn().mockResolvedValue([]),
      onActivityEvent: vi.fn().mockReturnValue(() => undefined),
      usageSummary: vi.fn().mockReturnValue(new Promise(() => undefined))
    })
  })

  const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })

  it('Home moves from Settings to Activity and focuses it', async () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    fireEvent.keyDown(tab('Settings'), { key: 'Home' })
    expect(tab('Activity')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Activity')).toHaveFocus()
    expect(localStorage.getItem('claude-desk:workspace-tab')).toBe('activity')
    await screen.findByRole('tabpanel')
  })

  it('ArrowLeft from Settings goes to Usage; ArrowLeft from Activity wraps to Settings', () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    fireEvent.keyDown(tab('Settings'), { key: 'ArrowLeft' })
    expect(tab('Usage')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Usage'), { key: 'Home' })
    fireEvent.keyDown(tab('Activity'), { key: 'ArrowLeft' })
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Settings')).toHaveFocus()
  })

  it('ArrowRight from Usage selects Settings and End on Settings keeps it selected', () => {
    render(<Workspace projectId={P1} />)
    fireEvent.keyDown(tab('Activity'), { key: 'ArrowRight' })
    fireEvent.keyDown(tab('Usage'), { key: 'ArrowRight' })
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Settings'), { key: 'End' })
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
  })

  it('other keys do nothing and are not prevented', () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    for (const key of ['Enter', ' ', 'a', 'ArrowUp', 'ArrowDown', 'Tab', 'PageDown']) {
      const notPrevented = fireEvent.keyDown(tab('Settings'), { key })
      expect(notPrevented, key).toBe(true)
      expect(tab('Settings'), key).toHaveAttribute('aria-selected', 'true')
    }
  })

  it('handled arrow keys are prevented from scrolling', () => {
    render(<Workspace projectId={P1} />)
    expect(fireEvent.keyDown(tab('Activity'), { key: 'ArrowRight' })).toBe(false)
  })

  it('uses a roving tabindex: only the selected Settings tab is tabbable', () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    expect(tab('Settings')).toHaveAttribute('tabindex', '0')
    expect(tab('Activity')).toHaveAttribute('tabindex', '-1')
    expect(tab('Usage')).toHaveAttribute('tabindex', '-1')
  })

  it('clicking the Settings tab selects it without moving focus logic errors, and the panel is labelled by it', async () => {
    render(<Workspace projectId={P1} />)
    fireEvent.click(tab('Settings'))
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', tab('Settings').getAttribute('aria-controls'))
    await screen.findByLabelText('Model')
  })

  it('keyboard activation of fields inside the panel does not switch tabs', async () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    const paths = await screen.findByLabelText('Protected paths')
    fireEvent.keyDown(paths, { key: 'ArrowRight' })
    fireEvent.keyDown(paths, { key: 'End' })
    fireEvent.keyDown(paths, { key: 'Home' })
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
  })

  it('an unknown stored tab value falls back to Activity', () => {
    localStorage.setItem('claude-desk:workspace-tab', 'bogus')
    render(<Workspace projectId={P1} />)
    expect(tab('Activity')).toHaveAttribute('aria-selected', 'true')
  })

  it('switching away and back shows the stored values again, not stale unsaved edits', async () => {
    localStorage.setItem('claude-desk:workspace-tab', 'settings')
    render(<Workspace projectId={P1} />)
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'opus' } })
    fireEvent.click(tab('Activity'))
    fireEvent.click(tab('Settings'))
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('auto'))
  })
})
