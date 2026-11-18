import { useCallback, useEffect, useState } from 'react'
import type { ChatEvent, ChatMessage, ChatSendError } from '@shared/ipc'
import { BRIDGE_UNAVAILABLE } from './useProjects'

export const SEND_ERROR_MESSAGES: Record<ChatSendError, string> = {
  'not-found': 'That project no longer exists.',
  busy: 'Claude is still answering. Please wait.',
  invalid: 'That message is not valid.'
}

export interface UseChat {
  messages: ChatMessage[]
  loading: boolean
  busy: boolean
  error: string | null
  send: (text: string) => Promise<void>
  /** A project the assistant proposed; nothing exists until the user confirms. */
  proposal: { name: string; brief: string } | null
  clearProposal: () => void
}

interface ChatState {
  projectId: string | null
  messages: ChatMessage[]
  loading: boolean
  busy: boolean
  error: string | null
  proposal: { name: string; brief: string } | null
}

const empty = (projectId: string | null): ChatState => ({
  projectId,
  messages: [],
  loading: projectId !== null,
  busy: false,
  error: null,
  proposal: null
})

function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  if (event.projectId !== state.projectId) return state
  if (event.type === 'text-delta') {
    const id = `stream:${event.turnId}`
    const last = state.messages[state.messages.length - 1]
    if (last && last.id === id) {
      const updated = { ...last, text: last.text + event.text }
      return { ...state, messages: [...state.messages.slice(0, -1), updated] }
    }
    const created: ChatMessage = { id, role: 'assistant', text: event.text, at: new Date().toISOString() }
    return { ...state, messages: [...state.messages, created] }
  }
  if (event.type === 'proposal') return { ...state, proposal: { name: event.name, brief: event.brief } }
  if (event.type === 'done') return { ...state, busy: false }
  return { ...state, busy: false, error: event.message }
}

export function useChat(projectId: string | null): UseChat {
  const [state, setState] = useState<ChatState>(() => empty(projectId))

  // Reset during render when the selected project changes.
  if (state.projectId !== projectId) setState(empty(projectId))

  useEffect(() => {
    const api = window.api
    if (!api || projectId === null) return
    let cancelled = false
    api
      .chatHistory({ projectId })
      .then((history) => {
        if (cancelled) return
        setState((s) =>
          s.projectId === projectId ? { ...s, messages: [...history, ...s.messages], loading: false } : s
        )
      })
      .catch(() => {
        if (cancelled) return
        setState((s) =>
          s.projectId === projectId ? { ...s, loading: false, error: 'Could not load the chat history.' } : s
        )
      })
    const unsubscribe = api.onChatEvent((event) => setState((s) => applyEvent(s, event)))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  const send = useCallback(
    async (text: string) => {
      const api = window.api
      if (projectId === null) return
      if (!api) {
        setState((s) => ({ ...s, error: BRIDGE_UNAVAILABLE }))
        return
      }
      const user: ChatMessage = {
        id: `local:${Date.now()}`,
        role: 'user',
        text,
        at: new Date().toISOString()
      }
      setState((s) => ({ ...s, busy: true, error: null, messages: [...s.messages, user] }))
      try {
        const result = await api.chatSend({ projectId, text })
        if (!result.ok) {
          setState((s) =>
            s.projectId === projectId
              ? {
                  ...s,
                  busy: result.error === 'busy' ? s.busy : false,
                  error: SEND_ERROR_MESSAGES[result.error],
                  messages: s.messages.filter((m) => m.id !== user.id)
                }
              : s
          )
        }
      } catch {
        setState((s) =>
          s.projectId === projectId
            ? { ...s, busy: false, error: 'Could not send the message.', messages: s.messages.filter((m) => m.id !== user.id) }
            : s
        )
      }
    },
    [projectId]
  )

  const clearProposal = useCallback(() => setState((s) => ({ ...s, proposal: null })), [])
  return { messages: state.messages, loading: state.loading, busy: state.busy, error: state.error, send, proposal: state.proposal, clearProposal }
}
