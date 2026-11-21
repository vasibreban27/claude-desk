// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { AgentView, DeskApi, ProjectAgentsView } from '@shared/ipc'
import { ToolkitPanel } from './ToolkitPanel'

const P = '11111111-1111-4111-8111-111111111111'

const agent = (over: Partial<AgentView>): AgentView => ({
  name: 'java-developer',
  role: 'worker',
  description: 'Implements Java tasks.',
  toolkitModel: 'sonnet',
  tools: ['Read', 'Edit'],
  source: 'agents/java-developer.md',
  body: '# Java\nUse layer-first packages.',
  override: null,
  effectiveModel: 'sonnet',
  modelSource: 'toolkit',
  usage: { sessions: 3, tokens: 45_000 },
  ...over
})

function view(over: Partial<ProjectAgentsView> = {}): ProjectAgentsView {
  return {
    toolkit: { name: 'flow', version: '1.4.0' },
    problems: [],
    houseRules: '',
    agents: [
      agent({}),
      agent({ name: 'python-developer', description: 'Python', override: { model: null, instructions: '', usedInPlans: false }, usage: null }),
      agent({ name: 'reviewer', role: 'reviewer', description: 'Reviews', usage: null }),
      agent({ name: 'test-writer', role: 'helper', description: 'Writes tests', toolkitModel: 'haiku', effectiveModel: 'haiku', usage: null })
    ],
    skills: [{ name: 'plan', description: 'Plans a phase', source: 'skills/plan/SKILL.md', body: 'Plan body' }],
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js', source: 'hooks/hooks.json' }],
    editable: true,
    ...over
  }
}

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = {
    agentsView: vi.fn().mockResolvedValue({ ok: true, view: view() }),
    agentsSave: vi.fn().mockResolvedValue({ ok: true }),
    agentsRules: vi.fn().mockResolvedValue({ ok: true }),
    agentsPreview: vi.fn().mockResolvedValue({
      ok: true,
      model: 'sonnet',
      modelSource: 'toolkit',
      layers: [
        { kind: 'toolkit', label: 'Agent instructions (claude-toolkit agents/java-developer.md)', text: 'Use layer-first packages.' },
        { kind: 'app', label: 'App rules (always win)', text: 'You are the "java-developer" worker' }
      ]
    })
  }
  window.api = api as unknown as DeskApi
})
afterEach(cleanup)

describe('ToolkitPanel', () => {
  it('groups agents by role with their model, and opens the first worker', async () => {
    render(<ToolkitPanel projectId={P} />)
    const nav = await screen.findByRole('navigation', { name: 'Toolkit items' })
    expect(within(nav).getByText('Workers')).toBeInTheDocument()
    expect(within(nav).getByText('Reviewers')).toBeInTheDocument()
    expect(within(nav).getByText('Helpers')).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /python-developer/ })).toHaveTextContent('off')
    expect(screen.getByRole('heading', { name: 'java-developer' })).toBeInTheDocument()
    expect(screen.getByText(/3 sessions and 45k tokens in the last 30 days/)).toBeInTheDocument()
    expect(await screen.findByText('Agent instructions (claude-toolkit agents/java-developer.md)')).toBeInTheDocument()
    expect(api['agentsPreview']).toHaveBeenCalledWith({ projectId: P, agent: 'java-developer' })
  })

  it('saves a project override and reloads', async () => {
    render(<ToolkitPanel projectId={P} />)
    await screen.findByRole('heading', { name: 'java-developer' })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Extra instructions'), { target: { value: 'Use MapStruct.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api['agentsSave']).toHaveBeenCalledWith({ projectId: P, agent: 'java-developer', override: { model: 'opus', instructions: 'Use MapStruct.', usedInPlans: true } })
    )
    await waitFor(() => expect(api['agentsView']).toHaveBeenCalledTimes(2))
  })

  it('resets a customized agent to the toolkit', async () => {
    render(<ToolkitPanel projectId={P} />)
    fireEvent.click(await screen.findByRole('button', { name: /python-developer/ }))
    expect(screen.getByRole('checkbox', { name: /planner may assign/ })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Reset to toolkit' }))
    await waitFor(() => expect(api['agentsSave']).toHaveBeenCalledWith({ projectId: P, agent: 'python-developer', override: null }))
  })

  it('edits house rules', async () => {
    render(<ToolkitPanel projectId={P} />)
    fireEvent.click(await screen.findByRole('button', { name: /House rules/ }))
    fireEvent.change(screen.getByLabelText('Rules for this project'), { target: { value: 'Records for DTOs.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api['agentsRules']).toHaveBeenCalledWith({ projectId: P, houseRules: 'Records for DTOs.' }))
    expect(await screen.findByText(/Saved. The next sessions use these rules./)).toBeInTheDocument()
  })

  it('shows helpers without project settings, and skills and hooks', async () => {
    render(<ToolkitPanel projectId={P} />)
    fireEvent.click(await screen.findByRole('button', { name: /test-writer/ }))
    expect(screen.getByText(/Project changes do not apply to helpers yet/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Extra instructions')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'plan' }))
    expect(screen.getByText('Plans a phase')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /PreToolUse/ }))
    expect(screen.getByText('node guard.js')).toBeInTheDocument()
  })

  it('filters the list', async () => {
    render(<ToolkitPanel projectId={P} />)
    const filter = await screen.findByLabelText('Filter toolkit')
    fireEvent.change(filter, { target: { value: 'python' } })
    const nav = screen.getByRole('navigation', { name: 'Toolkit items' })
    expect(within(nav).queryByRole('button', { name: /java-developer/ })).toBeNull()
    expect(within(nav).getByRole('button', { name: /python-developer/ })).toBeInTheDocument()
  })

  it('is read-only without the database and explains a missing toolkit', async () => {
    api['agentsView']!.mockResolvedValueOnce({ ok: true, view: view({ editable: false }) })
    const { unmount } = render(<ToolkitPanel projectId={P} />)
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument()
    expect(screen.getByLabelText('Model')).toBeDisabled()
    unmount()
    api['agentsView']!.mockResolvedValueOnce({ ok: false, error: 'no-toolkit' })
    render(<ToolkitPanel projectId={P} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/No toolkit is set up/)
  })
})
