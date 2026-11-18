import { createSdkMcpServer, tool, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { validProjectName } from '../projects/createProject'
import { PLAN_WORKERS } from '../pipeline/planParser'

export const ASSISTANT_SERVER = 'assistant'
export const CREATE_PROJECT_TOOL = `mcp__${ASSISTANT_SERVER}__create_project`
export const BRIEF_MAX = 2000

export const ASSISTANT_PROMPT = [
  'You are the workspace assistant of claude-desk. You are not inside any project and have no file or shell access yourself.',
  'Your only action is the create_project tool. When the user wants a new app or project, call it once with a short lowercase name',
  '(letters, digits and hyphens), the worker that fits the stack (node-developer, python-developer, java-developer, frontend-developer,',
  'database-engineer) and a brief of a few lines: the stack, the features and how to run it.',
  'After the user confirms, the app creates the folder and git repo, writes the brief as a plan and starts a pipeline run: a worker scaffolds',
  'the project on a branch (it can install dependencies), checks and reviewers run, and the result is merged per policy.',
  'The tool only proposes the project. Tell the user to confirm the card, then stop.',
  'For anything else, answer briefly in text.'
].join(' ')

export interface Proposal {
  name: string
  brief: string
  worker: string | null
}

/** The in-process tool never creates anything: it validates and reports the proposal. */
export function createAssistantServer(onProposal: (p: Proposal) => void): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: ASSISTANT_SERVER,
    tools: [
      tool(
        'create_project',
        'Propose a new project. Nothing is created until the user confirms in the UI.',
        {
          name: z.string().max(100),
          brief: z.string().max(BRIEF_MAX),
          worker: z.enum(PLAN_WORKERS as [string, ...string[]]).optional()
        },
        async (args) => {
          if (!validProjectName(args.name)) {
            return { content: [{ type: 'text' as const, text: 'Invalid name: use 2-49 lowercase letters, digits or hyphens, starting with a letter or digit.' }], isError: true }
          }
          onProposal({ name: args.name, brief: args.brief, worker: args.worker ?? null })
          return { content: [{ type: 'text' as const, text: 'pending: waiting for the user to confirm the project in the UI.' }] }
        }
      )
    ]
  })
}

/** Deny-by-default: only the proposal tool may run. */
export const assistantGuard: HookCallback = async (input) => {
  const name = (input as { tool_name?: unknown }).tool_name
  if (name === CREATE_PROJECT_TOOL) return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: 'The assistant can only use create_project.'
    }
  }
}

export function assistantOptions(onProposal: (p: Proposal) => void): Partial<Options> {
  return {
    systemPrompt: ASSISTANT_PROMPT,
    tools: [],
    allowedTools: [CREATE_PROJECT_TOOL],
    mcpServers: { [ASSISTANT_SERVER]: createAssistantServer(onProposal) },
    hooks: { PreToolUse: [{ hooks: [assistantGuard], onFailure: 'block' }] }
  }
}
