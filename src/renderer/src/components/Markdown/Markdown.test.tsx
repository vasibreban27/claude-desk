// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Markdown } from './Markdown'
import { safeLink } from './safeLink'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  return writeText
}

describe('safeLink', () => {
  it.each(['https://x.dev', 'http://x.dev/a', 'mailto:a@b.c'])('keeps %s', (u) => {
    expect(safeLink(u)).toBe(u)
  })
  it.each(['javascript:alert(1)', 'data:text/html,x', '/rel', '//evil.com', 'rel', '', undefined, 'JaVaScRiPt:1'])(
    'rejects %s',
    (u) => {
      expect(safeLink(u)).toBeNull()
    }
  )
})

describe('Markdown', () => {
  it('renders structure elements and wraps tables', () => {
    const text = '# T\n\n- a\n- b\n\n1. x\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\n`inline`\n\n```\nplain\n```'
    const { container } = render(<Markdown text={text} />)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(container.querySelector('ul')).toBeInTheDocument()
    expect(container.querySelector('ol')).toBeInTheDocument()
    expect(container.querySelector('.markdown__table > table th')).toBeInTheDocument()
    expect(container.querySelector('td')).toHaveTextContent('c1')
    expect(container.querySelector('p code')).toHaveTextContent('inline')
    expect(container.querySelector('pre code')).toBeInTheDocument()
  })

  it('shows language label, highlights supported languages and copies exact code', async () => {
    const writeText = stubClipboard()
    const { container } = render(<Markdown text={'```ts\nconst a = 1\n```'} />)
    expect(screen.getByText('ts')).toBeInTheDocument()
    expect(container.querySelector('.hljs-keyword')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument(), {
      timeout: 2500
    })
  })

  it('renders unknown languages plain', () => {
    const { container } = render(<Markdown text={'```nope\nfoo bar\n```'} />)
    expect(screen.getByText('nope')).toBeInTheDocument()
    expect(container.querySelector('pre code')).toHaveTextContent('foo bar')
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
  })

  it('never renders raw html', () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b>x</b>'} />
    )
    expect(container.querySelector('script, img, b')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
  })

  it('keeps safe links as inert buttons and drops unsafe ones', async () => {
    const writeText = stubClipboard()
    const text =
      '[a](https://x.dev) [b](mailto:a@b.c) [c](javascript:alert(1)) [d](data:text/html,x) [e](/rel) [f](//evil.com)'
    const { container } = render(<Markdown text={text} />)
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('title', 'https://x.dev')
    expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute('title', 'mailto:a@b.c')
    for (const name of ['c', 'd', 'e', 'f']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
      expect(container).toHaveTextContent(name)
    }
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x.dev'))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('shows alt text instead of images', () => {
    const { container } = render(<Markdown text="![the alt](https://x/y.png)" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('the alt')
  })

  it('does not re-render for the same text and updates on change', () => {
    const { container, rerender } = render(<Markdown text="# one" />)
    const heading = container.querySelector('h1')
    rerender(<Markdown text="# one" />)
    expect(container.querySelector('h1')).toBe(heading)
    rerender(<Markdown text="# two" />)
    expect(container.querySelector('h1')).toHaveTextContent('two')
  })
})
