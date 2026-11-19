import { z } from 'zod'
import {
  AUTO_FIX_ROUNDS_RANGE,
  DEFAULT_REVIEWERS,
  REVIEWERS_MAX_COUNT,
  REVIEWER_NAMES
} from './review'

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
export const DELIVERY_CHOICES = ['manual', 'open-pr', 'merge-local'] as const
export type DeliveryChoice = (typeof DELIVERY_CHOICES)[number]

const protectedPathSchema = z
  .string()
  .min(1)
  .max(PROTECTED_PATH_MAX_LENGTH)
  .refine((s) => !s.includes('\0'), { message: 'NUL is not allowed' })

export const CHECKS_MAX_COUNT = 8
export const CHECK_ARGS_MAX_COUNT = 16

const noNul = (s: string): boolean => !s.includes('\0')

/** A trusted, user-configured command a pipeline worker may run by name. Never read from the repo. */
export const checkSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  executable: z.string().min(1).max(260).refine(noNul, { message: 'NUL is not allowed' }),
  args: z
    .array(z.string().min(1).max(500).refine(noNul, { message: 'NUL is not allowed' }))
    .max(CHECK_ARGS_MAX_COUNT),
  timeoutMs: z.number().int().min(1000).max(600000),
  acceptsTestPath: z.boolean().optional()
})
export type CheckConfig = z.infer<typeof checkSchema>

const checksSchema = z
  .array(checkSchema)
  .max(CHECKS_MAX_COUNT)
  .refine((list) => new Set(list.map((c) => c.name)).size === list.length, {
    message: 'check names must be unique'
  })

export const MAX_PARALLEL_LIMIT = 4
export const DEFAULT_MAX_PARALLEL = 2
export const MAX_TURNS_RANGE = { min: 5, max: 100, default: 40 } as const
export const TIME_LIMIT_MINUTES_RANGE = { min: 1, max: 120, default: 20 } as const

export const projectSettingsSchema = z.object({
  version: z.literal(1),
  model: z.enum(MODEL_CHOICES),
  protectedPaths: z.array(protectedPathSchema).max(PROTECTED_PATHS_MAX_COUNT),
  allowGitRead: z.boolean(),
  allowPlanWrites: z.boolean(),
  /** Added in Phase 4a without a version bump; absent means no checks. */
  checks: checksSchema.optional(),
  /** Added in Phase 4c without a version bump; absent means the default. */
  maxParallel: z.number().int().min(1).max(MAX_PARALLEL_LIMIT).optional(),
  maxTurns: z.number().int().min(MAX_TURNS_RANGE.min).max(MAX_TURNS_RANGE.max).optional(),
  taskTimeoutMinutes: z
    .number()
    .int()
    .min(TIME_LIMIT_MINUTES_RANGE.min)
    .max(TIME_LIMIT_MINUTES_RANGE.max)
    .optional(),
  /** Added in Phase 5a without a version bump; absent means the default. Bounded: limits SDK spend. */
  autoFixRounds: z
    .number()
    .int()
    .min(AUTO_FIX_ROUNDS_RANGE.min)
    .max(AUTO_FIX_ROUNDS_RANGE.max)
    .optional(),
  /** Added in Phase 7 without a version bump: workers may use the allow-listed run_command tool. */
  allowCommands: z.boolean().optional(),
  /** What the app does after a successful pipeline run. */
  delivery: z.enum(DELIVERY_CHOICES).optional(),
  reviewers: z
    .array(z.enum(REVIEWER_NAMES))
    .max(REVIEWERS_MAX_COUNT)
    .refine((list) => new Set(list).size === list.length, {
      message: 'reviewers must be unique'
    })
    .optional()
})
export type ProjectSettings = z.infer<typeof projectSettingsSchema>
export type ModelChoice = ProjectSettings['model']

export function defaultSettings(): ProjectSettings {
  return {
    version: 1,
    model: 'auto',
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    allowGitRead: false,
    allowPlanWrites: false,
    checks: [],
    maxParallel: DEFAULT_MAX_PARALLEL,
    maxTurns: MAX_TURNS_RANGE.default,
    taskTimeoutMinutes: TIME_LIMIT_MINUTES_RANGE.default,
    autoFixRounds: AUTO_FIX_ROUNDS_RANGE.default,
    allowCommands: false,
    delivery: 'manual',
    reviewers: [...DEFAULT_REVIEWERS]
  }
}

export interface EffectiveLimits {
  maxParallel: number
  maxTurns: number
  timeCapMs: number
}

/** The single place that applies the limit defaults. */
export function effectiveLimits(
  settings: Pick<ProjectSettings, 'maxParallel' | 'maxTurns' | 'taskTimeoutMinutes'>
): EffectiveLimits {
  return {
    maxParallel: settings.maxParallel ?? DEFAULT_MAX_PARALLEL,
    maxTurns: settings.maxTurns ?? MAX_TURNS_RANGE.default,
    timeCapMs: (settings.taskTimeoutMinutes ?? TIME_LIMIT_MINUTES_RANGE.default) * 60000
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
  const limits = effectiveLimits(parsed.data)
  return {
    settings: {
      ...parsed.data,
      checks: parsed.data.checks ?? [],
      maxParallel: limits.maxParallel,
      maxTurns: limits.maxTurns,
      taskTimeoutMinutes: limits.timeCapMs / 60000,
      autoFixRounds: parsed.data.autoFixRounds ?? AUTO_FIX_ROUNDS_RANGE.default,
      allowCommands: parsed.data.allowCommands ?? false,
      delivery: parsed.data.delivery ?? 'manual',
      reviewers: parsed.data.reviewers ?? [...DEFAULT_REVIEWERS]
    },
    case: 'ok'
  }
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
