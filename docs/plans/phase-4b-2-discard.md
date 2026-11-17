Format: flow-plan/1

# Phase 4b-2: Discard button for a finished run

## Goal

As the owner I want to discard a finished or failed run from the Pipeline tab so that its worktrees and branches do not pile up and I do not have to remove them by hand.

Outcomes:
- A run that is not running shows a Discard button with a confirmation that says exactly what is removed.
- Confirming removes the run's worktrees and branches and its rows, and the tab returns to the plan list.

## Scope

In: the discard button, its confirmation and error messages, one manual-check step.

Out (do not build): any new IPC, service or handler code (`pipeline:discard` is already implemented and wired in 4b-1, see `docs/plans/phase-4b-1-run-and-status.md`); a run history list; merging or pushing a run; the 4c queue; Phase 5. Start this plan after 4b-1 is verified.

## Architecture

The renderer calls the existing `pipeline:discard` through `window.api.pipelineDiscard` and re-fetches `pipeline:status`. Rejected: discarding without a confirmation (the commits on the run branches are lost, so it is a destructive action).

Contract used: `pipeline:discard  req: { projectId: uuid, runId: string }  ok: { ok: true }  err: { ok: false, error: "not-found" | "active" | "cleanup-failed" }` (defined in the 4b-1 plan).

## Changes per layer

- **API / IPC:** none (already in 4b-1).
- **Service (main):** none.
- **Database:** none.
- **UI:** Discard button and confirmation in the Pipeline tab; `usePipeline` gains a `discard` action.
- **Docs:** one step in `docs/notes/phase-4b-2-manual-check.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Discarding deletes unmerged work | Explicit confirmation naming the branches and worktrees; the button is hidden while the run is active; `main` is never touched. |
| Cleanup fails and leaves worktrees behind | The service keeps the rows and returns `cleanup-failed`; the UI shows it and keeps the run visible so the user can retry. |

## Test strategy

Component and hook tests with a mocked `window.api`. No smoke task: no runtime wiring changes (the channel was wired and smoke-tested in 4b-1); the manual note has one extra step. Deliberately not tested: the real removal (covered in the 4b-1 service tests).

## Wave 1: discard button

### T1: Discard button with confirmation
- Status: [ ] todo
- Worker: frontend-developer
- Size: S
- Sensitive: no
- Contract: pipeline:discard
- Owns: `src/renderer/src/components/Pipeline/`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/hooks/usePipeline.test.ts`, `docs/notes/phase-4b-2-manual-check.md`
- Read first: `src/shared/ipc.ts`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/hooks/usePipeline.test.ts`, `src/renderer/src/components/Pipeline/PipelinePanel.tsx`, `docs/notes/phase-4b-1-manual-check.md`
- Depends on: none
- Done when: `npm test -- src/renderer/src/components/Pipeline src/renderer/src/hooks/usePipeline.test.ts`
- Acceptance criteria:
  - Given a run that is not active When the run view is shown Then a Discard button is visible; while the run is active it is not rendered.
  - Given Discard is clicked When the confirmation opens Then it names the integration branch and the task branches, says commits on them are lost and that the base branch is not touched, and offers Cancel and Discard; Cancel closes it without calling the API.
  - Given the user confirms When `pipelineDiscard` resolves ok Then status is re-fetched, the run view is replaced by the plan list, and focus moves to a sensible element.
  - Given `active`, `not-found` or `cleanup-failed` results When they come back Then each shows a distinct readable message in an alert and the run stays visible (for `cleanup-failed` with a hint to retry).
  - Given a double click on Discard When the first call is pending Then the button is disabled and `pipelineDiscard` is called once.
  - Given `docs/notes/phase-4b-2-manual-check.md` When read Then it has the steps to discard a finished run, a failed run, and to see that Discard is absent while a run is active, with the expected result for each.

## Follow-ups
