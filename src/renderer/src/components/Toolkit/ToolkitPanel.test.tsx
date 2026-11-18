// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolkitPanel } from './ToolkitPanel'

const listing = {
  plugin: { name: 'flow', version: '0.10.0', description: null },
  agents: [{ name: 'worker', description: 'Builds', model: 'sonnet', tools: ['Read'], source: 'agents/worker.md', body: 'Agent body' }],
  skills: [{ name: 'plan', description: 'Plans', source: 'skills/plan/SKILL.md', body: 'Skill body' }],
  hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js', source: 'hooks/hooks.json' }],
  problems: [{ file: 'agents/bad.md', reason: 'missing frontmatter' }]
}
const toolkitList = vi.fn()

afterEach(cleanup)
beforeEach(() => {
  toolkitList.mockReset()
  ;(window as unknown as { api: unknown }).api = { toolkitList }
})

describe('ToolkitPanel', () => {
  it('lists sections, problems, filters and shows details', async () => {
    toolkitList.mockResolvedValue({ ok: true, listing })
    render(<ToolkitPanel />)
    expect(await screen.findByText('Agents (1)')).toBeInTheDocument()
    expect(screen.getByText('Skills (1)')).toBeInTheDocument()
    expect(screen.getByText('Hooks (1)')).toBeInTheDocument()
    expect(screen.getByText('agents/bad.md: missing frontmatter')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'worker' }))
    expect(screen.getByText('Agent body')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter toolkit'), { target: { value: 'zzz' } })
    expect(screen.getByText('Agents (0)')).toBeInTheDocument()
  })

  it('shows the unset error', async () => {
    toolkitList.mockResolvedValue({ ok: false, error: 'unset' })
    render(<ToolkitPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('CLAUDE_TOOLKIT_PATH')
  })

  it('shows a generic error when the call rejects', async () => {
    toolkitList.mockRejectedValue(new Error('x'))
    render(<ToolkitPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load')
  })
})
