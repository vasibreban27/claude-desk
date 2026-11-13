import { useCallback, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CHAT_TEXT_MAX } from '@shared/ipc'
import type { UseChat } from '../../hooks/useChat'
import { Markdown } from '../Markdown'
import { isNearBottom } from './stickToBottom'
import './chat.css'

export interface ChatPanelProps extends UseChat {
  hasProject: boolean
}

export function ChatPanel({ hasProject, messages, loading, busy, error, send }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [pinned, setPinned] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pinnedRef = useRef(true)
  const disabled = !hasProject || busy
  const canSend = !disabled && draft.trim().length > 0

  const setPin = (value: boolean) => {
    pinnedRef.current = value
    setPinned(value)
  }

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Follow new messages and streamed deltas while pinned to the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [messages, busy, scrollToBottom])

  // Grow the textarea with its content; CSS max-height makes it scroll beyond that.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const onScroll = () => {
    const el = listRef.current
    if (el) setPin(isNearBottom(el))
  }

  const jump = () => {
    setPin(true)
    scrollToBottom()
  }

  const submit = () => {
    if (!canSend) return
    const text = draft
    setDraft('')
    setPin(true)
    void send(text)
  }

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault()
    submit()
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      submit()
    }
  }

  return (
    <div className="chat">
      <div className="chat__scroller">
        <div
          ref={listRef}
          className="chat__messages"
          role="log"
          aria-live="polite"
          aria-label="Messages"
          onScroll={onScroll}
        >
          {loading && <p className="chat__empty">Loading messages…</p>}
          {!hasProject && !loading && (
            <p className="chat__empty">Add or select a project to start chatting with Claude.</p>
          )}
          {!loading && hasProject && messages.length === 0 && (
            <p className="chat__empty">No messages yet. Ask Claude about this project.</p>
          )}
          {messages.map((m) => {
            const author = m.role === 'user' ? 'You' : 'Claude'
            return (
              <article key={m.id} className={`chat__message chat__message--${m.role}`} aria-label={author}>
                <span className="chat__author" aria-hidden="true">
                  {author}
                </span>
                {m.role === 'user' ? <p className="chat__text">{m.text}</p> : <Markdown text={m.text} />}
              </article>
            )
          })}
          {busy && (
            <div className="chat__indicator">
              <span aria-hidden="true" className="chat__dot" />
              <span aria-hidden="true" className="chat__dot" />
              <span aria-hidden="true" className="chat__dot" />
              <span className="chat__sr">Claude is answering…</span>
            </div>
          )}
        </div>
        {!pinned && busy && (
          <button type="button" className="chat__jump" onClick={jump}>
            Jump to latest
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="chat__error">
          <span className="chat__error-label">Something went wrong</span>
          {error}
        </div>
      )}
      <form onSubmit={onSubmit} className="chat__form">
        <label htmlFor="chat-input">Message</label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          disabled={disabled}
          placeholder={hasProject ? 'Ask Claude about this project' : 'Add or select a project to chat'}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  )
}
