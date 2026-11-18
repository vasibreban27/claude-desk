// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProposalCard } from './ProposalCard'

afterEach(cleanup)
const api = { projectsRootGet: vi.fn(), projectsRootPick: vi.fn(), createProject: vi.fn() }
beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  ;(window as unknown as { api: unknown }).api = api
})
const project = { id: 'p', name: 'demo-app', path: '/r/demo-app', branch: 'main', dirty: false }

describe('ProposalCard', () => {
  it('creates nothing until the user clicks, then hands off with the brief', async () => {
    api.projectsRootGet.mockResolvedValue({ root: '/r' })
    api.createProject.mockResolvedValue({ ok: true, project })
    const onCreated = vi.fn()
    render(<ProposalCard name="demo-app" brief="add a README" onCreated={onCreated} onCancel={vi.fn()} />)
    await screen.findByText('Folder: /r/demo-app')
    expect(api.createProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project))
    expect(api.createProject).toHaveBeenCalledWith({ name: 'demo-app', enableCommands: true })
  })

  it('needs a projects folder and shows creation errors', async () => {
    api.projectsRootGet.mockResolvedValue({ root: null })
    render(<ProposalCard name="demo-app" brief="b" onCreated={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('No projects folder set.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
    api.projectsRootPick.mockResolvedValue({ root: '/r' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose projects folder' }))
    api.createProject.mockResolvedValue({ ok: false, error: 'exists' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
  })
})
