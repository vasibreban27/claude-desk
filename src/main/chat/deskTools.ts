import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { PLAN_FILE_PATTERN } from '../../shared/ipc'

/** In-process tools the app offers to a planning chat. */
export const DESK_SERVER = 'desk'
export const START_PIPELINE_TOOL = `mcp__${DESK_SERVER}__start_pipeline`

/** Starts the app's pipeline for a plan; resolves the text the model sees. Never throws. */
export type StartPipeline = (planFile: string) => Promise<string>

export function createDeskServer(startPipeline: StartPipeline): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: DESK_SERVER,
    tools: [
      tool(
        'start_pipeline',
        'Start the claude-desk pipeline for a plan in docs/plans (pass the file name, for example "greet-cli.md"). ' +
          'Use it when the user asks to build, run or start the plan. Workers build each task on its own branch, then checks ' +
          'and reviewers run; the user merges from the Pipeline tab.',
        { planFile: z.string().max(100) },
        async (args) => {
          const name = args.planFile.replace(/^docs[\\/]plans[\\/]/, '')
          if (!PLAN_FILE_PATTERN.test(name)) {
            return { content: [{ type: 'text' as const, text: 'Invalid plan file: pass the file name in docs/plans, for example "todo-api.md".' }], isError: true }
          }
          let text: string
          try {
            text = await startPipeline(name)
          } catch {
            text = 'The pipeline could not be started.'
          }
          return { content: [{ type: 'text' as const, text }] }
        }
      )
    ]
  })
}

export const BUILD_IN_APP_NOTE = [
  'Building in claude-desk: never run /flow:build, Bash or worker agents from this chat (they are blocked here).',
  'When the user asks to build, run or start the plan, call the start_pipeline tool with the plan file name; the app runs',
  'the workers, checks and reviewers and shows progress in its Pipeline tab. Report the tool result in one line and stop.'
].join(' ')
