// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { UseProjects } from '../../hooks/useProjects'
import { ProjectsPanel } from './ProjectsPanel'

afterEach(cleanup)

function props(over: Partial<UseProjects> = {}): UseProjects {
  return {
    projects: [],
    selectedId: null,
    loading: false,
    loadError: null,
    addError: null,
    adding: false,
    add: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(undefined),
    adopt: vi.fn(),
    remove: vi.fn().mockResolvedValue(null),
    ...over
  }
}

const sample = [
  { id: 'a', name: 'alpha', path: '/a', branch: 'main', dirty: false },
  { id: 'b', name: 'beta', path: '/b', branch: null, dirty: true }
] as UseProjects['projects']

describe('ProjectsPanel', () => {
  it('shows name, branch or detached, and text badges', () => {
    render(<ProjectsPanel {...props({ projects: sample })} />)
    expect(screen.getByText('alpha')).toHaveAttribute('title', 'alpha')
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('detached')).toBeInTheDocument()
    expect(screen.getByText('clean')).toBeInTheDocument()
    expect(screen.getByText('dirty')).toBeInTheDocument()
  })

  it('marks the selected project and selects on click', () => {
    const p = props({ projects: sample, selectedId: 'a' })
    render(<ProjectsPanel {...p} />)
    expect(screen.getByRole('button', { name: /^alpha/ })).toHaveAttribute('aria-pressed', 'true')
    const beta = screen.getByRole('button', { name: /^beta/ })
    expect(beta).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(beta)
    expect(p.select).toHaveBeenCalledWith('b')
  })

  it('shows the empty state with Add project still available', () => {
    render(<ProjectsPanel {...props()} />)
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled()
  })

  it('Add project opens a folder directly when the app offers no new-project chat', () => {
    const p = props()
    render(<ProjectsPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(p.add).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group', { name: 'Add project' })).toBeNull()
  })

  it('Add project offers a new project in chat or an existing folder', () => {
    const p = props()
    const onNewProject = vi.fn()
    render(<ProjectsPanel {...p} onNewProject={onNewProject} />)
    const add = screen.getByRole('button', { name: 'Add project' })
    expect(add).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^New project/ }))
    expect(onNewProject).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group', { name: 'Add project' })).toBeNull()

    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: /^Existing folder/ }))
    expect(p.add).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group', { name: 'Add project' })).toBeNull()
  })

  it('shows loading and hides the empty state', () => {
    render(<ProjectsPanel {...props({ loading: true })} />)
    expect(screen.getByText('Loading projects…')).toBeInTheDocument()
    expect(screen.queryByText(/No projects yet/)).toBeNull()
  })

  it('shows load and add errors as alerts', () => {
    render(<ProjectsPanel {...props({ loadError: 'load failed', addError: 'add failed' })} />)
    expect(screen.getByText('load failed')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('add failed')).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/No projects yet/)).toBeNull()
  })

  it('mounts the theme toggle in the footer', () => {
    render(<ProjectsPanel {...props()} />)
    expect(screen.getByRole('contentinfo')).toContainElement(screen.getByRole('group', { name: 'Theme' }))
  })
})
