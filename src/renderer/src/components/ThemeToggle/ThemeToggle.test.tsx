// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('keeps the legend outside the options grid so it cannot squeeze the options', () => {
    const { container } = render(<ThemeToggle />)
    const options = container.querySelector('.theme-toggle__options')
    expect(options).not.toBeNull()
    expect(options?.querySelectorAll('input[type="radio"]')).toHaveLength(3)
    expect(options?.querySelector('legend')).toBeNull()
    expect(container.querySelector('legend')?.parentElement?.tagName).toBe('FIELDSET')
  })

  it('lays options out with real gaps and by container width, without a floated legend', () => {
    const css = readFileSync(join(import.meta.dirname, 'theme-toggle.css'), 'utf8')
    // Regression: a floated legend becomes a flex item and crushed the options together.
    expect(css).not.toMatch(/float\s*:/)
    expect(css).toMatch(/\.theme-toggle__options\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.theme-toggle__options\s*\{[^}]*gap:\s*var\(--space-2\)/)
    expect(css).toMatch(/container-type:\s*inline-size/)
    expect(css).toMatch(/@container\s*\(min-width:/)
  })

  it('reflects a stored mode on mount', () => {
    window.localStorage.setItem('claude-desk:theme', 'light')
    render(<ThemeToggle />)
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
  })
})
