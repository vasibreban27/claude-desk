import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { CHAT_TEXT_MAX } from '@shared/ipc'
import type { UseChat } from '../../hooks/useChat'

export interface ChatPanelProps extends UseChat {
  hasProject: boolean
}

export function ChatPanel({ hasProject, messages, loading, busy, error, send }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const disabled = !hasProject || busy
  const canSend = !disabled && draft.trim().length > 0

  const submit = () => {
    if (!canSend) return
    const text = draft
    setDraft('')
    void send(text)
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="chat">
      <div className="chat__messages" role="log" aria-live="polite" aria-label="Messages">
        {loading && <p>Loading messages…</p>}
        {!loading && hasProject && messages.length === 0 && <p>No messages yet. Ask Claude about this project.</p>}
        {messages.map((m) => (
          <p key={m.id} className={`chat__message chat__message--${m.role}`}>
            <strong>{m.role === 'user' ? 'You' : 'Claude'}: </strong>
            {m.text}
          </p>
        ))}
        {busy && <p className="chat__status">Claude is answering…</p>}
      </div>
      {error && (
        <p role="alert" className="chat__error">
          {error}
        </p>
      )}
      <form onSubmit={onSubmit} className="chat__form">
        <label htmlFor="chat-input">Message</label>
        <textarea
          id="chat-input"
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          disabled={disabled}
          placeholder={hasProject ? 'Ask Claude about this project' : 'Add or select a project to chat'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  )
}
