// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ThemeToggle } from './ThemeToggle'

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(cleanup)

describe('ThemeToggle', () => {
  it('is a labelled group with three native radio options, system selected by default', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
  })

  it('applies the chosen theme and reflects it', () => {
    render(<ThemeToggle />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    fireEvent.click(screen.getByRole('radio', { name: 'System' }))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('gives every option its own icon and a theme-specific preview style', () => {
    const { container } = render(<ThemeToggle />)
    for (const mode of ['system', 'light', 'dark']) {
      const label = container.querySelector(`.theme-toggle__label--${mode}`)
      expect(label).not.toBeNull()
      const icon = label?.querySelector('svg.theme-toggle__icon')
      expect(icon).not.toBeNull()
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
    // The accessible name stays the plain label, the icon adds nothing to it.
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument()
  })

  it('reflects a stored mode on mount', () => {
    window.localStorage.setItem('claude-desk:theme', 'light')
    render(<ThemeToggle />)
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
  })
})
