# Phase 4b-1: checks verification (T6)

Verified with `tests/phase-4b-checks.test.ts` (real `run_check` tool, real vitest 5.1, temp project outside the repo, Windows 11).

- testPath: `./<rel>` works with vitest `run --globals`; only the named file ran. No fallback without `./` was needed, so none was added.
- env: the check passed under the tool's reduced environment (allowlist unchanged); no variable had to be added.
- npm: `{ executable: 'npm', args: ['--version'] }` started through the tool on Windows (node plus npm-cli.js) and passed, printing `11.19.0`.
