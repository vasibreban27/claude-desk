/// <reference types="node" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { App } from '../../App'
import { Layout } from './Layout'
import { readFileSync } from 'node:fs'

afterEach(cleanup)

describe('Layout', () => {
  it('renders projects, workspace and chat landmarks in order with names', () => {
    render(<App />)
    const projects = screen.getByRole('complementary', { name: 'Projects' })
    const workspace = screen.getByRole('main', { name: 'Workspace' })
    const chat = screen.getByRole('region', { name: 'Chat' })
    expect(projects.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(workspace.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a placeholder in the workspace when nothing is provided', () => {
    render(<App />)
    expect(screen.getByText(/Runs, activity and usage will appear here/)).toBeInTheDocument()
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
    expect(css).toMatch(/grid-template-columns:\s*minmax\(0,/)
    expect(css).toMatch(/overflow-x:\s*hidden/)
  })
})
