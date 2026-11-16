# Plan: Phase 2 close-out

Source: `docs/plans/phase-2-tracking-and-usage.md`, section 10 "Follow-ups" (the "Still open" list and the Round 5 items). No new features and nothing from Phase 3.

Branch: `phase-2-tracking-usage` (never `main`). Do not push and do not open a PR.

## 1. Goal

Phase 2 passes a final security audit (PASS, no open S findings), the full suite is green three runs in a row on Windows, and the docs are lean, so Phase 3 starts from a clean base.

## 2. Scope

In: S70, S61, F40-F44, F12, F13 (only if cheap), the flaky tests, docs housekeeping.

Out: Phase 3 work (settings panel, per-project model, protected paths), the SDK `permissionMode`/`canUseTool` spike, the UNC symlink case that could not be created on the test machine, the timezone test on macOS and Linux, any change to the `claude-toolkit` repo.

## 3. Constraints

- Tasks T1-T4 all own `src/main/chat/tools.ts` and `src/main/chat/tools.test.ts`. They run in sequence, never in parallel, one commit each.
- T5 touches only test files and can share a wave with T1. T6 is docs only (main thread).
- Win32 deny rules are lexical: 0 filesystem calls, checked next to the existing `..`, `~` and NUL checks.
- Every new regression test must fail on the code before its fix and pass after it (the worker shows this by running the test before the change).
- Symlink and junction tests: rethrow unless the error code is `EPERM`, `EACCES` or `ENOSYS`, then `ctx.skip()`.

## 4. Tasks

### Wave 1

#### T1: S70, win32 trailing dot and space segments (`node-developer`)
Files: `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`.
- On win32 deny any segment ending in `.` or a space, other than `.` and `..`. Apply it to path arguments, every brace expansion, every literal glob prefix and intermediate segments.
- Tests (0 fs calls asserted via the fs spy): Grep path `jfirst.`, Read `jfirst./s.txt`, Read `src/a/jmid./s.txt`, a glob prefix such as `jfirst./**`, a brace expansion such as `{a,jfirst.}/**`, and a trailing-space segment. One real-junction test that reproduces the original read-outside case if junctions can be created (skip otherwise).
- Done when: all cases denied with 0 fs calls; `.` and `..` segments and normal names with inner dots (`a.b`, `.hidden`) still behave as before.

#### T5: Flaky tests (`node-developer`)
Files: `src/main/git/status.test.ts`, `tests/integration/main-flow.test.ts`, `tests/phase-2-flow.test.ts` (and `vitest.config.ts` only if a serial pool is chosen).
- Scoped timeouts (per file or per test) or a serial pool for these files; do not raise the global timeout.
- `afterEach` cleanup uses `rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })` in all three files.
- Done when: both files pass under a full parallel run, three times, with no EPERM in cleanup.

### Wave 2

#### T2: S61, bound link-chain cost (`node-developer`)
Files: `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`.
- Option A: `realpathSync.native` for `realCwd` and link resolution, derived from the same function, after checking on win32 that junction, 8.3 and case results match the JS implementation. Option B: resolve one `readlinkSync` hop at a time and charge each hop to the probe budget. Pick A if the check passes, else B, and write the reason in a code comment.
- Test: a long chain (for example 60 hops) of in-project junctions plus a brace glob is denied or resolved with a bounded call count (assert counts, not time).
- Done when: the test fails before and passes after; the call count is bounded.

### Wave 3

#### T3: Budget and usability (F40, F41, F42) (`node-developer`)
Files: `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`.
- F40: raise `MAX_PROBES` to about 512 (the `{16 dirs}/{8 dirs}/src/**` case, 272 probes, must pass) and keep the deny message accurate.
- F41: apply the 4096-char cap to the pattern string; count only literal-prefix segments toward the segment cap.
- F42: an absolute path in long form with a cwd in 8.3 form, and the reverse, is allowed when it is inside; if not feasible, fail closed and document it in a comment and in the plan.
- Done when: tests for each, including an over-long brace-free pattern denied with 0 fs calls.

### Wave 4

#### T4: Test gaps and POSIX backslash (F43, F44, F12, F13) (`node-developer`)
Files: `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`.
- F43: tests for dangling links (inside and outside targets), relative link targets, a cwd that is itself a link, win32 case handling. Fix the symlink helper per the constraint above.
- F44: remove the `performance.now() < 500` assertions and fix the test title that still says 64 expansions.
- F12: on non-win32 deny glob patterns containing a backslash (test with a mocked platform).
- F13: only if the change is a few lines; otherwise record it as won't-fix in the history note (the search tool does not follow links).
- Done when: no `performance.now()` left in the file; tests skip cleanly where links cannot be created.

### Wave 5 (main thread, can run during any wave)

#### T6: Docs housekeeping
- `CLAUDE.md`: remove the stale "Current state" section and the duplicated project description; keep Commands and Conventions exact.
- Move the resolved history from section 10 of the Phase 2 plan, plus the "Findings by wave" block, into `docs/notes/phase-2-followups-history.md`. Section 10 keeps only open items (manual live checks, the `--follow` note, the timezone test, the UNC case, and anything T1-T4 leave open) and links the history note.
- `docs/notes/phase-2-manual-check.md`: first step is `npm run build`; checks (c) and (d) get concrete prompts or a throwaway skill.
- Update section 10 again after T1-T4 land, so S61, S70 and F40-F44 are recorded as resolved in the history note.

## 5. Wave summary

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | T1, T5 | yes, disjoint files |
| 2 | T2 | single task, owns `tools.ts` |
| 3 | T3 | single task, owns `tools.ts` |
| 4 | T4 | single task, owns `tools.ts` |
| 5 | T6 | main thread, docs only |

If T2-T4 turn out small, merge them into one task. They must never run in parallel.

## 6. Verify

- `security-auditor` (Opus, path security) on the final `tools.ts` diff: PASS and no open S findings.
- `reviewer`: PASS.
- `npm run typecheck`, `npm run lint` and `npm test` pass three consecutive times.
- `CLAUDE.md` has no "no source code yet" text; the Phase 2 plan's Follow-ups lists only open items.

## 7. Report to the owner

Remaining for the owner: the live manual check (`docs/notes/phase-2-manual-check.md`) and opening the PR. Nothing is pushed.

## 8. Risks

- `realpathSync.native` may differ from the JS version for junctions, 8.3 names or case; the check in T2 decides the option.
- Junction creation can fail on some machines; those tests skip, so the lexical S70 tests must carry the 0-fs-call proof on their own.
- A serial pool slows the suite; prefer scoped timeouts first.
