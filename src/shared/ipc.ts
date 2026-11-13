import { z } from 'zod'

/** Single definition of every IPC channel, payload and event. Shared by main, preload and renderer. */

export const CHAT_TEXT_MAX = 20000

export const IPC = {
  projectsList: 'projects:list',
  projectsPickAndAdd: 'projects:pick-and-add',
  projectsRefresh: 'projects:refresh',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatEvent: 'chat:event'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// --- Entities ---------------------------------------------------------------

export const projectSchema = z.object({
  id: z.uuid(),
  path: z.string().min(1),
  name: z.string(),
  /** null on a detached HEAD; unborn branch name in a repo with no commits. */
  branch: z.string().nullable(),
  dirty: z.boolean(),
  addedAt: z.iso.datetime({ offset: true })
})
export type Project = z.infer<typeof projectSchema>

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.iso.datetime({ offset: true })
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

// --- Request schemas (validated in main handlers) ---------------------------

export const projectsRefreshRequestSchema = z.object({ id: z.uuid() })
export type ProjectsRefreshRequest = z.infer<typeof projectsRefreshRequestSchema>

export const chatHistoryRequestSchema = z.object({ projectId: z.uuid() })
export type ChatHistoryRequest = z.infer<typeof chatHistoryRequestSchema>

export const chatSendRequestSchema = z.object({
  projectId: z.uuid(),
  text: z.string().min(1).max(CHAT_TEXT_MAX)
})
export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>

// --- Results ----------------------------------------------------------------

export type ProjectsListResult = Project[]

export type PickAndAddError = 'cancelled' | 'not-a-git-repo' | 'duplicate' | 'unreadable'
export type ProjectsPickAndAddResult =
  | { ok: true; project: Project }
  | { ok: false; error: PickAndAddError }

export type RefreshError = 'not-found' | 'unreadable'
export type ProjectsRefreshResult =
  | { ok: true; project: Project }
  | { ok: false; error: RefreshError }

export type ChatHistoryResult = ChatMessage[]

export type ChatSendError = 'not-found' | 'busy' | 'invalid'
export type ChatSendResult = { ok: true; turnId: string } | { ok: false; error: ChatSendError }

// --- Events (main -> renderer) ----------------------------------------------

export type ChatEvent =
  | { projectId: string; turnId: string; type: 'text-delta'; text: string }
  | { projectId: string; turnId: string; type: 'done' }
  | { projectId: string; turnId: string; type: 'error'; message: string }

// --- Renderer-facing API exposed as window.api ------------------------------

export interface DeskApi {
  listProjects(): Promise<ProjectsListResult>
  pickAndAddProject(): Promise<ProjectsPickAndAddResult>
  refreshProject(req: ProjectsRefreshRequest): Promise<ProjectsRefreshResult>
  chatHistory(req: ChatHistoryRequest): Promise<ChatHistoryResult>
  chatSend(req: ChatSendRequest): Promise<ChatSendResult>
  /** Subscribe to chat events; returns an unsubscribe function. */
  onChatEvent(listener: (event: ChatEvent) => void): () => void
}
