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
        <label htmlFor="chat-input" className="chat__sr">
          Message
        </label>
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
        <div className="chat__composer">
          <div className="chat__tools">
            <button
              type="button"
              className="chat__tool"
              aria-label="Attach files"
              title="Attach images or files (you can also paste or drop them here)"
              disabled={disabled || reading}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </button>
            {dictation.supported && (
              <button
                type="button"
                className={`chat__tool${recording ? ' chat__tool--recording' : ''}`}
                aria-label={recording ? 'Stop recording' : 'Dictate'}
                aria-pressed={recording}
                title={recording ? 'Stop and transcribe' : 'Dictate with the microphone (transcribed on this PC)'}
                disabled={disabled || dictation.state === 'starting' || dictation.state === 'transcribing'}
                onClick={dictation.toggle}
              >
                {recording ? <StopIcon /> : <MicIcon />}
              </button>
            )}
          </div>
          <textarea
            id="chat-input"
            ref={inputRef}
            className="chat__input"
            rows={2}
            value={draft}
            maxLength={CHAT_TEXT_MAX}
            disabled={disabled}
            placeholder={placeholder ?? (hasProject ? 'Ask Claude about this project' : 'Add or select a project to chat')}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button type="submit" className="chat__send" disabled={!canSend}>
            Send
          </button>
        </div>
        <div className="chat__footer">
          {recording ? (
            <p role="status" className="chat__status chat__status--recording">
              <span className="chat__rec-dot" aria-hidden="true" />
              Recording {Math.floor(dictation.seconds / 60)}:{String(dictation.seconds % 60).padStart(2, '0')} · click stop to transcribe
            </p>
          ) : dictation.error || attachError ? (
            <p role="status" className="chat__status chat__status--error">
              {dictation.error ?? attachError}
            </p>
          ) : dictation.state === 'transcribing' ? (
            <p role="status" className="chat__status">
              {dictation.downloadPercent !== null
                ? `Downloading the speech model (first time only, about 80 MB)… ${dictation.downloadPercent}%`
                : 'Transcribing…'}
            </p>
          ) : (
            <p className="chat__status chat__status--hint">Enter to send · Shift+Enter for a new line · paste or drop files</p>
          )}
          {dictation.supported && (
            <label className="chat__lang" title="Language you speak when dictating">
              <MicIcon size={12} />
              <select
                aria-label="Dictation language"
                value={dictation.language}
                disabled={recording || dictation.state === 'transcribing'}
                onChange={(ev) => dictation.setLanguage(ev.target.value as SpeechLanguage)}
              >
                {SPEECH_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {SPEECH_LANGUAGE_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
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

/** Line icons drawn with the text colour, so they match the theme (emoji render small and faint here). */
function Icon({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <Icon>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Icon>
  )
}

function MicIcon({ size }: { size?: number }) {
  return (
    <Icon {...(size !== undefined ? { size } : {})}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </Icon>
  )
}

function StopIcon() {
  return (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </Icon>
  )
}
