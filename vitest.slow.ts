/** Real-git, integration-flow and live tests: excluded from `npm test`, run by `npm run test:slow`. */
export const SLOW_TESTS = [
  'tests/phase-*-flow.test.ts',
  'tests/phase-4b-checks.test.ts',
  'tests/live/**',
  'src/main/pipeline/worktrees.test.ts',
  'src/main/chat/gitTools*.test.ts'
]
