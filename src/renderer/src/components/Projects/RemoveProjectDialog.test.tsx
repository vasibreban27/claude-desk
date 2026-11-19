// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/ipc'
import { ProjectsPanel } from './ProjectsPanel'
import { RemoveProjectDialog } from './RemoveProjectDialog'

afterEach(cleanup)

const P: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'demo',
  path: 'C:\\work\\demo',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}

describe('RemoveProjectDialog', () => {
  it('removes from the app only by default', async () => {
    const onRemove = vi.fn().mockResolvedValue(null)
    const onClose = vi.fn()
    render(<RemoveProjectDialog project={P} onRemove={onRemove} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onRemove).toHaveBeenCalledWith(false)
  })

  it('deletes the folder only after ticking the box, naming the path', async () => {
    const onRemove = vi.fn().mockResolvedValue(null)
    render(<RemoveProjectDialog project={P} onRemove={onRemove} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Also move the folder to the Recycle Bin'))
    expect(screen.getByText('C:\\work\\demo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove and delete folder' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(true))
  })

  it('shows the error and stays open when removal fails', async () => {
    const onClose = vi.fn()
    render(<RemoveProjectDialog project={P} onRemove={vi.fn().mockResolvedValue('A pipeline run is active: cancel it first.')} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('pipeline run is active')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers no folder deletion for a missing folder', () => {
    render(<RemoveProjectDialog project={{ ...P, missing: true }} onRemove={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByLabelText('Also move the folder to the Recycle Bin')).toBeNull()
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument()
  })
})

describe('ProjectsPanel remove', () => {
  it('shows missing projects and opens the dialog from the remove button', () => {
    render(
      <ProjectsPanel
        projects={[{ ...P, missing: true }]}
        selectedId={null}
        loading={false}
        loadError={null}
        addError={null}
        adding={false}
        add={vi.fn()}
        select={vi.fn()}
        adopt={vi.fn()}
        remove={vi.fn()}
      />
    )
    expect(screen.getByText('missing')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove demo' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove demo?')
  })
})
