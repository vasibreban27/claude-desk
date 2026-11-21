import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { CHAT_TEXT_MAX, SPEECH_LANGUAGES, SPEECH_LANGUAGE_NAMES, type AttachmentRef, type SpeechLanguage } from '@shared/ipc'
import type { UseChat } from '../../hooks/useChat'
import { Markdown } from '../Markdown'
import { formatSize, readAttachments, type DraftAttachment } from './attachDraft'
import { isNearBottom } from './stickToBottom'
import { useDictation, type DictationDeps } from './useDictation'
import './chat.css'

export interface ChatPanelProps extends UseChat {
  hasProject: boolean
  /** Overrides the input placeholder (plan mode, new project). */
  placeholder?: string
  /** Overrides the text shown when there are no messages yet. */
  emptyText?: string
  /** Shown just above the message box (e.g. the plan-ready card), so it stays in view. */
  aboveInput?: ReactNode
  /** Tests only: replaces the browser microphone. */
  dictationDeps?: DictationDeps
}

export function ChatPanel({
  hasProject,
  messages,
  loading,
  busy,
  error,
  send,
  placeholder,
  emptyText,
  aboveInput,
  dictationDeps
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [reading, setReading] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pinned, setPinned] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pinnedRef = useRef(true)
  const disabled = !hasProject || busy
  // Dictated text is added to the message box; the user still reviews it and presses Send.
  const dictation = useDictation((text) => {
    setDraft((d) => (d.trim() === '' ? text : `${d.trimEnd()} ${text}`))
    inputRef.current?.focus()
  }, dictationDeps)
  const recording = dictation.state === 'recording'
  const canSend = !disabled && !reading && !recording && dictation.state !== 'transcribing' && (draft.trim().length > 0 || files.length > 0)

  // A replaced message set (project switch) finishes loading: start pinned at the bottom again.
  const [prevLoading, setPrevLoading] = useState(loading)
  if (prevLoading !== loading) {
    setPrevLoading(loading)
    if (!loading) setPinned(true)
  }

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
    pinnedRef.current = pinned
    if (pinned) scrollToBottom()
  }, [messages, busy, pinned, scrollToBottom])

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

  /** Reads pasted, dropped or picked files into the message box; problems are shown under it. */
  const addFiles = async (list: readonly File[]) => {
    if (list.length === 0 || disabled) return
    setReading(true)
    try {
      const { added, problems } = await readAttachments(list, files.length)
      setFiles((current) => [...current, ...added])
      setAttachError(problems.length > 0 ? problems.join(' ') : null)
    } finally {
      setReading(false)
    }
  }

  const onPaste = (ev: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(ev.clipboardData?.files ?? [])
    if (pasted.length === 0) return
    ev.preventDefault()
    void addFiles(pasted)
  }

  const onDragOver = (ev: DragEvent<HTMLFormElement>) => {
    if (disabled || !Array.from(ev.dataTransfer?.types ?? []).includes('Files')) return
    ev.preventDefault()
    setDragging(true)
  }

  const onDrop = (ev: DragEvent<HTMLFormElement>) => {
    setDragging(false)
    const dropped = Array.from(ev.dataTransfer?.files ?? [])
    if (dropped.length === 0) return
    ev.preventDefault()
    void addFiles(dropped)
  }

  const submit = () => {
    if (!canSend) return
    const text = draft
    const attachments = files.map((f) => f.attachment)
    setDraft('')
    setFiles([])
    setAttachError(null)
    setPin(true)
    void send(text, attachments)
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
          {loading && hasProject && <p className="chat__empty">Loading messages…</p>}
          {!hasProject && !loading && (
            <p className="chat__empty">Add or select a project to start chatting with Claude.</p>
          )}
          {!loading && hasProject && messages.length === 0 && (
            <p className="chat__empty">{emptyText ?? 'No messages yet. Ask Claude about this project.'}</p>
          )}
          {messages.map((m) => {
            const author = m.role === 'user' ? 'You' : 'Claude'
            return (
              <article key={m.id} className={`chat__message chat__message--${m.role}`} aria-label={author}>
                <span className="chat__author" aria-hidden="true">
                  {author}
                </span>
                {m.role === 'user' ? (
                  <>
                    {m.text.trim() !== '' && <p className="chat__text">{m.text}</p>}
                    {m.attachments && m.attachments.length > 0 && <SentAttachments refs={m.attachments} />}
                  </>
                ) : (
                  <Markdown text={m.text} />
                )}
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
        {!pinned && messages.length > 0 && (
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
      {aboveInput}
      <form
        onSubmit={onSubmit}
        className={`chat__form${dragging ? ' chat__form--drop' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label htmlFor="chat-input">Message</label>
        {files.length > 0 && (
          <ul className="chat__attachments" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.id} className="chat__attachment">
                {f.preview ? (
                  <img src={f.preview} alt={f.attachment.name} className="chat__thumb" />
                ) : (
                  <span className="chat__file-icon" aria-hidden="true">
                    📄
                  </span>
                )}
                <span className="chat__attachment-name" title={f.attachment.name}>
                  {f.attachment.name}
                </span>
                <span className="chat__attachment-size">{formatSize(f.size)}</span>
                <button
                  type="button"
                  className="chat__attachment-remove"
                  aria-label={`Remove ${f.attachment.name}`}
                  onClick={() => setFiles((current) => current.filter((x) => x.id !== f.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {(dictation.state === 'transcribing' || dictation.error) && (
          <p role="status" className={dictation.error ? 'chat__attach-error' : 'chat__dictation-status'}>
            {dictation.error ??
              (dictation.downloadPercent !== null
                ? `Downloading the speech model (first time only, about 80 MB)… ${dictation.downloadPercent}%`
                : 'Transcribing…')}
          </p>
        )}
        {attachError && (
          <p role="status" className="chat__attach-error">
            {attachError}
          </p>
        )}
        <button
          type="button"
          className="chat__attach"
          aria-label="Attach files"
          title="Attach images or files (you can also paste or drop them here)"
          disabled={disabled || reading}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        {dictation.supported && (
          <>
            <button
              type="button"
              className={`chat__mic${recording ? ' chat__mic--on' : ''}`}
              aria-label={recording ? 'Stop recording' : 'Dictate'}
              aria-pressed={recording}
              title={recording ? 'Stop and transcribe' : 'Dictate with the microphone (transcribed on this PC)'}
              disabled={disabled || dictation.state === 'starting' || dictation.state === 'transcribing'}
              onClick={dictation.toggle}
            >
              {recording ? `■ ${Math.floor(dictation.seconds / 60)}:${String(dictation.seconds % 60).padStart(2, '0')}` : '🎤'}
            </button>
            <select
              className="chat__mic-lang"
              aria-label="Dictation language"
              value={dictation.language}
              disabled={recording || dictation.state === 'transcribing'}
              onChange={(ev) => dictation.setLanguage(ev.target.value as SpeechLanguage)}
            >
              {SPEECH_LANGUAGES.map((l) => (
                <option key={l} value={l} title={SPEECH_LANGUAGE_NAMES[l]}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-testid="chat-file-input"
          onChange={(ev) => {
            const picked = Array.from(ev.target.files ?? [])
            ev.target.value = ''
            void addFiles(picked)
          }}
        />
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          disabled={disabled}
          placeholder={placeholder ?? (hasProject ? 'Ask Claude about this project' : 'Add or select a project to chat')}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  )
}

/** What was sent with a message: names only (the bytes are not kept in the history). */
function SentAttachments({ refs }: { refs: AttachmentRef[] }) {
  return (
    <ul className="chat__sent-attachments" aria-label="Sent attachments">
      {refs.map((r, i) => (
        <li key={`${r.name}-${i}`} title={r.path ?? r.name}>
          <span aria-hidden="true">{r.kind === 'image' ? '🖼 ' : '📄 '}</span>
          {r.name}
        </li>
      ))}
    </ul>
  )
}

