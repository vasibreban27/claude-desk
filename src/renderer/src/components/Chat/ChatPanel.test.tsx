// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ChatMessage } from '@shared/ipc'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'

afterEach(cleanup)

const msg = (id: string, role: 'user' | 'assistant', text: string): ChatMessage => ({
  id,
  role,
  text,
  at: '2026-01-01T00:00:00.000Z'
})

function setup(props: Partial<ChatPanelProps> = {}) {
  const send = vi.fn().mockResolvedValue(undefined)
  const all: ChatPanelProps = {
    hasProject: true,
    proposal: null,
    clearProposal: vi.fn(),
    planReady: null,
    clearPlanReady: vi.fn(),
    messages: [],
    loading: false,
    busy: false,
    error: null,
    send,
    ...props
  }
  const view = render(<ChatPanel {...all} />)
  return { send, view, all }
}

function mockMetrics(el: HTMLElement, m: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: m.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: m.clientHeight })
  el.scrollTop = m.scrollTop
}

describe('ChatPanel', () => {
  it('renders user text plain and assistant text as markdown, with author labels', () => {
    setup({ messages: [msg('1', 'user', '**raw**\nline2'), msg('2', 'assistant', '**bold**')] })
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent('**raw**')
    const claude = screen.getByRole('article', { name: 'Claude' })
    expect(claude.querySelector('strong')).toHaveTextContent('bold')
  })

  it('shows the streaming indicator only while busy', () => {
    const { view, all } = setup({ busy: true })
    expect(screen.getByText('Claude is answering…')).toBeInTheDocument()
    view.rerender(<ChatPanel {...all} busy={false} />)
    expect(screen.queryByText('Claude is answering…')).toBeNull()
  })

  it('shows an error banner with role alert', () => {
    setup({ error: 'Toolkit path missing' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong')
    expect(alert).toHaveTextContent('Toolkit path missing')
  })

  it('shows empty and loading states', () => {
    const { view, all } = setup({ hasProject: false })
    expect(screen.getByText(/Add or select a project to start/)).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    view.rerender(<ChatPanel {...all} hasProject />)
    expect(screen.getByText('No messages yet. Ask Claude about this project.')).toBeInTheDocument()
    view.rerender(<ChatPanel {...all} hasProject loading />)
    expect(screen.getByText('Loading messages…')).toBeInTheDocument()
  })

  it('exposes the message list as a labelled log', () => {
    setup()
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveAttribute('aria-live', 'polite')
  })

  it('Enter sends, Shift+Enter does not', () => {
    const { send } = setup()
    const input = screen.getByLabelText('Message')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('hi')
    expect(input).toHaveValue('')
  })

  it('keeps pinned to the bottom, and pauses with a jump button when scrolled up', () => {
    const { view, all } = setup({ busy: true, messages: [msg('1', 'assistant', 'a')] })
    const log = screen.getByRole('log')
    mockMetrics(log, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
    fireEvent.scroll(log)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()

    view.rerender(<ChatPanel {...all} messages={[msg('1', 'assistant', 'ab')]} />)
    expect(log.scrollTop).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(log.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()

    view.rerender(<ChatPanel {...all} messages={[msg('1', 'assistant', 'abc')]} />)
    expect(log.scrollTop).toBe(1000)
  })

  it('sending always scrolls to the bottom', () => {
    const { view, all } = setup({ messages: [msg('1', 'assistant', 'a')] })
    const log = screen.getByRole('log')
    mockMetrics(log, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
    fireEvent.scroll(log)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    view.rerender(<ChatPanel {...all} messages={[msg('1', 'assistant', 'a'), msg('2', 'user', 'x')]} />)
    expect(log.scrollTop).toBe(1000)
  })

  it('keeps the jump button after the turn finishes while scrolled up (F1)', () => {
    const { view, all } = setup({ busy: true, messages: [msg('1', 'assistant', 'a')] })
    const log = screen.getByRole('log')
    mockMetrics(log, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
    fireEvent.scroll(log)
    view.rerender(<ChatPanel {...all} busy={false} />)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()
  })

  it('returns to the bottom when a new message set finishes loading (F2)', () => {
    const { view, all } = setup({ messages: [msg('1', 'assistant', 'a')] })
    const log = screen.getByRole('log')
    mockMetrics(log, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
    fireEvent.scroll(log)
    view.rerender(<ChatPanel {...all} messages={[]} loading />)
    view.rerender(<ChatPanel {...all} messages={[msg('2', 'assistant', 'b')]} loading={false} />)
    expect(log.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('does not show the loading line without a project (F3)', () => {
    setup({ hasProject: false, loading: true })
    expect(screen.queryByText('Loading messages…')).toBeNull()
  })
})
