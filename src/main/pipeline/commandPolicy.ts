/**
 * Allow list for the worker `run_command` tool (enabled per project with `allowCommands`).
 * Commands run with execFile and an argv array (never a shell), cwd fixed to the worktree,
 * a timeout and the checks environment. Each executable allows a fixed set of subcommands;
 * everything else is denied. npm installs always get `--ignore-scripts`.
 */
export const COMMAND_TIMEOUT_MS = 10 * 60_000
export const MAX_COMMAND_ARGS = 30
const MAX_ARG_LENGTH = 300

type Rule = (args: readonly string[]) => string | null

const CREATE_PKG = /^(@[a-z0-9][a-z0-9._-]*\/)?create-[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._-]+)?$/
const firstIn =
  (allowed: readonly string[]): Rule =>
  (args) =>
    args[0] !== undefined && allowed.includes(args[0]) ? null : `allowed subcommands: ${allowed.join(', ')}`

const RULES: Readonly<Record<string, Rule>> = {
  npm: firstIn(['install', 'i', 'ci', 'init', 'run', 'test', 'pkg', 'uninstall']),
  npx: (args) => {
    const pkg = args.find((a) => !a.startsWith('-'))
    if (pkg === undefined || !CREATE_PKG.test(pkg)) return 'npx only runs create-* scaffolders (for example create-vite)'
    const flags = args.slice(0, args.indexOf(pkg)).filter((a) => a !== '--yes' && a !== '-y')
    return flags.length === 0 ? null : 'npx flags before the package: only --yes'
  },
  python: (args) =>
    args[0] === '-m' && ['venv', 'pip', 'pytest'].includes(args[1] ?? '') ? null : 'python only runs -m venv, -m pip or -m pytest',
  py: (args) =>
    args[0] === '-m' && ['venv', 'pip', 'pytest'].includes(args[1] ?? '') ? null : 'py only runs -m venv, -m pip or -m pytest',
  pip: firstIn(['install', 'uninstall', 'freeze']),
  uv: firstIn(['init', 'add', 'remove', 'sync', 'lock', 'venv', 'run']),
  dotnet: firstIn(['new', 'restore', 'build', 'test', 'add']),
  go: firstIn(['mod', 'build', 'test', 'get', 'vet']),
  cargo: firstIn(['init', 'new', 'add', 'build', 'test', 'check']),
  mvn: firstIn(['-q', 'package', 'test', 'compile', 'verify']),
  gradle: firstIn(['build', 'test', 'init'])
}

export const ALLOWED_COMMANDS: readonly string[] = Object.keys(RULES)

export type CommandDecision = { ok: true; command: string; args: string[] } | { ok: false; error: string }

/** Validates an executable name and its arguments; returns the args to run (npm installs get --ignore-scripts). */
export function checkCommand(command: unknown, args: unknown): CommandDecision {
  if (typeof command !== 'string' || !Object.hasOwn(RULES, command)) {
    return { ok: false, error: `command not allowed; allowed: ${ALLOWED_COMMANDS.join(', ')}` }
  }
  if (!Array.isArray(args) || args.length > MAX_COMMAND_ARGS) return { ok: false, error: 'args must be a short array of strings' }
  for (const a of args) {
    if (typeof a !== 'string' || a.length === 0 || a.length > MAX_ARG_LENGTH || /[\0\r\n]/.test(a)) {
      return { ok: false, error: 'each arg must be a non-empty single-line string' }
    }
  }
  const list = args as string[]
  const rule = RULES[command] as Rule
  const why = rule(list)
  if (why !== null) return { ok: false, error: `${command}: ${why}` }
  const out = [...list]
  if (command === 'npm' && ['install', 'i', 'ci'].includes(out[0] ?? '') && !out.includes('--ignore-scripts')) {
    out.push('--ignore-scripts')
  }
  return { ok: true, command, args: out }
}
