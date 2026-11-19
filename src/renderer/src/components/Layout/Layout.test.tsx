/// <reference types="node" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { App } from '../../App'
import { Layout, LAYOUT_STORAGE_KEY, readStoredLayout } from './Layout'
import { readFileSync } from 'node:fs'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('Layout', () => {
  it('renders projects, workspace and chat landmarks in order with names', () => {
    render(<App />)
    const projects = screen.getByRole('complementary', { name: 'Projects' })
    const workspace = screen.getByRole('main', { name: 'Workspace' })
    const chat = screen.getByRole('region', { name: 'Chat' })
    expect(projects.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(workspace.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows app settings before a project is selected', () => {
    render(<App />)
    expect(screen.getByRole('region', { name: 'App' })).toBeInTheDocument()
  })

  it('renders content passed as props', () => {
    render(<Layout projects={<p>P</p>} workspace={<p>W</p>} chat={<p>C</p>} />)
    expect(screen.getByText('P')).toBeInTheDocument()
    expect(screen.getByText('W')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
    expect(screen.queryByText(/will appear here/)).toBeNull()
  })

  it('never hides a panel or scrolls horizontally on narrow windows', () => {
    const css = readFileSync('src/renderer/src/styles/layout.css', 'utf8')
    expect(css).not.toMatch(/display:\s*none/)
    expect(css).not.toMatch(/@media/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).toMatch(/min-width:\s*0/)
    expect(css).toMatch(/overflow-x:\s*hidden/)
  })

  it('renders two separators between the panels', () => {
    render(<Layout projects={<p>P</p>} chat={<p>C</p>} />)
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('changes the neighbouring sizes with the keyboard on a focused separator', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    })
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
    render(<Layout projects={<p>P</p>} chat={<p>C</p>} />)
    const sep = screen.getAllByRole('separator')[0] as HTMLElement
    const before = sep.getAttribute('aria-valuenow')
    sep.focus()
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    const after = sep.getAttribute('aria-valuenow')
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(Number(after)).toBeGreaterThan(Number(before))
    for (let i = 0; i < 60; i++) fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    const min = Number(sep.getAttribute('aria-valuenow'))
    expect(min).toBeLessThan(Number(before))
    expect(min).toBeGreaterThan(0)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(min)
    rect.mockRestore()
    offsetWidth.mockRestore()
    offsetHeight.mockRestore()
  })

  it('shows the designed workspace empty state', () => {
    render(<Layout projects={<p>P</p>} chat={<p>C</p>} />)
    expect(screen.getByText('Nothing running yet')).toBeInTheDocument()
    expect(screen.getByText(/Runs, activity and usage will appear here/)).toBeInTheDocument()
  })

  it('restores a stored layout and falls back on corrupt data', () => {
    expect(readStoredLayout()).toEqual({ projects: 20, workspace: 45, chat: 35 })
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ projects: 30, workspace: 40, chat: 30 }))
    expect(readStoredLayout()).toEqual({ projects: 30, workspace: 40, chat: 30 })
    for (const bad of ['{not json', 'null', '{"projects":"a"}', '{"projects":50,"workspace":50,"chat":50}']) {
      localStorage.setItem(LAYOUT_STORAGE_KEY, bad)
      expect(readStoredLayout()).toEqual({ projects: 20, workspace: 45, chat: 35 })
    }
    expect(() => render(<Layout projects={<p>P</p>} chat={<p>C</p>} />)).not.toThrow()
  })
})
