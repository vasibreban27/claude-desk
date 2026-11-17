import { z } from 'zod'

/** Per-project settings: one versioned JSON object, validated at every boundary. */

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '.git/'
]

export const PROTECTED_PATH_MAX_LENGTH = 200
export const PROTECTED_PATHS_MAX_COUNT = 100

export const MODEL_CHOICES = ['auto', 'haiku', 'sonnet', 'opus'] as const

const protectedPathSchema = z
  .string()
  .min(1)
  .max(PROTECTED_PATH_MAX_LENGTH)
  .refine((s) => !s.includes('\0'), { message: 'NUL is not allowed' })

export const projectSettingsSchema = z.object({
  version: z.literal(1),
  model: z.enum(MODEL_CHOICES),
  protectedPaths: z.array(protectedPathSchema).max(PROTECTED_PATHS_MAX_COUNT),
  allowGitRead: z.boolean(),
  allowPlanWrites: z.boolean()
})
export type ProjectSettings = z.infer<typeof projectSettingsSchema>
export type ModelChoice = ProjectSettings['model']

export function defaultSettings(): ProjectSettings {
  return {
    version: 1,
    model: 'auto',
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    allowGitRead: false,
    allowPlanWrites: false
  }
}

export type SettingsParseCase = 'ok' | 'missing' | 'invalid-json' | 'invalid-schema'

export interface SettingsParseResult {
  settings: ProjectSettings
  /** Which case produced the result; anything but 'ok' means defaults were applied. */
  case: SettingsParseCase
}

/** Parse a stored JSON string; never throws and never loosens: any failure yields the defaults. */
export function parseSettingsOrDefaults(raw: string | undefined): SettingsParseResult {
  if (raw === undefined) return { settings: defaultSettings(), case: 'missing' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { settings: defaultSettings(), case: 'invalid-json' }
  }
  const parsed = projectSettingsSchema.safeParse(json)
  if (!parsed.success) return { settings: defaultSettings(), case: 'invalid-schema' }
  return { settings: parsed.data, case: 'ok' }
}

/**
 * Options that are not honoured on session resume. Empty: the spike showed
 * model, allowedTools and mcpServers are all honoured on resume (see
 * docs/notes/phase-3-spike.md). Kept so a later SDK version can repopulate it.
 */
export const SESSION_RESET_OPTIONS: readonly (keyof ProjectSettings)[] = []

export function needsSessionReset(
  previous: ProjectSettings,
  next: ProjectSettings,
  options: readonly (keyof ProjectSettings)[] = SESSION_RESET_OPTIONS
): boolean {
  return options.some((key) => previous[key] !== next[key])
}
