import { useCallback, useEffect, useState } from 'react'
import type { Attachment, ChatEvent, ChatMessage, ChatMode, ChatSendError } from '@shared/ipc'
import { BRIDGE_UNAVAILABLE } from './useProjects'

export const SEND_ERROR_MESSAGES: Record<ChatSendError, string> = {
  'not-found': 'That project no longer exists.',
  busy: 'Claude is still answering. Please wait.',
  invalid: 'That message is not valid.'
}

export interface PlanReady {
  planFile: string
  /** First parse error, or null when the pipeline can run it. */
  problem: string | null
}

export interface UseChat {
  messages: ChatMessage[]
  loading: boolean
  busy: boolean
  error: string | null
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  /** The latest plan the planner wrote in this chat. */
  planReady: PlanReady | null
  clearPlanReady: () => void
  /** The run the planner started from chat ("build it"); the app shows the Pipeline tab. */
  pipelineStarted: { runId: string; planFile: string } | null
}

interface ChatState {
  projectId: string | null
  messages: ChatMessage[]
  loading: boolean
  busy: boolean
  error: string | null
  planReady: PlanReady | null
  pipelineStarted: { runId: string; planFile: string } | null
}

/** Cards survive switching projects (the chat state is reset then); cleared when the user acts on them. */
const plans = new Map<string, PlanReady>()

const empty = (projectId: string | null): ChatState => ({
  projectId,
  messages: [],
  loading: projectId !== null,
  busy: false,
  error: null,
  planReady: projectId !== null ? (plans.get(projectId) ?? null) : null,
  pipelineStarted: null
})

/** Records cards for any project, so one that arrives while another chat is open is not lost. */
function remember(event: ChatEvent): void {
  if (event.type === 'plan-ready') plans.set(event.projectId, { planFile: event.planFile, problem: event.problem })
  if (event.type === 'pipeline-started') plans.delete(event.projectId)
}

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
  if (event.type === 'plan-ready') return { ...state, planReady: { planFile: event.planFile, problem: event.problem } }
  if (event.type === 'pipeline-started') {
    return { ...state, planReady: null, pipelineStarted: { runId: event.runId, planFile: event.planFile } }
  }
  if (event.type === 'done') return { ...state, busy: false }
  return { ...state, busy: false, error: event.message }
}

export function useChat(projectId: string | null, mode: ChatMode = 'chat'): UseChat {
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
    const unsubscribe = api.onChatEvent((event) => {
      remember(event)
      setState((s) => applyEvent(s, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  const send = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
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
        at: new Date().toISOString(),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => ({ kind: a.kind, name: a.name })) } : {})
      }
      setState((s) => ({ ...s, busy: true, error: null, messages: [...s.messages, user] }))
      try {
        const result = await api.chatSend({
          projectId,
          text,
          ...(mode === 'plan' ? { mode } : {}),
          ...(attachments.length > 0 ? { attachments } : {})
        })
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
    [projectId, mode]
  )

  const clearPlanReady = useCallback(() => {
    if (projectId !== null) plans.delete(projectId)
    setState((s) => ({ ...s, planReady: null }))
  }, [projectId])

  return {
    messages: state.messages,
    loading: state.loading,
    busy: state.busy,
    error: state.error,
    send,
    planReady: state.planReady,
    clearPlanReady,
    pipelineStarted: state.pipelineStarted
  }
}
