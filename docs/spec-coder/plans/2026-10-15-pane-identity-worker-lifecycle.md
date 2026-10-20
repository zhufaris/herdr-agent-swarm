# Pane identity and Worker lifecycle projection plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Native implement-spec executor after Gate 3. Selected specification:
`docs/spec-coder/specs/2026-10-15-pane-identity-worker-lifecycle.md`.
Authoritative workspace is the existing isolated worktree at
`<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`.
Recorded wave base: `46236e81882842233e3e75c8dc2f7334d178230c`. Serial execution
is preferred because identity contracts and card-context selection share module
ownership. Baseline evidence is recorded in the specification. Gate 1 selected
option B; the model observability extension reopened Gate 2/3 and was approved
in this request.

## Wave W1: `T1`

### - [x] T1: Propagate unified pane identity to cards

| Field | Content |
| --- | --- |
| What to build | Add provider-neutral PaneIdentitySnapshot propagation for branch/worktree/pane identity across Worker Main, Primary Topic/Pane cards and directory entries; update runtime reducers idempotently. |
| Spec references | SCN-1, SCN-2 |
| Dependencies | None |
| Delegation eligibility | Bounded projection and renderer change with pure reducer/card-context seams. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `domain/topic-view.ts`, `domain/worker-main-view.ts`, `domain/worker-main-selector.ts`, the presentation port and operations query builder, card-context store, pane/topic/worker card renderers and their tests. Preserve lease/Herdr authority boundaries. |
| Mutation ownership | src/domain/topic-view.ts, src/domain/worker-main-view.ts, src/domain/worker-main-selector.ts, src/domain/ports/presentation.ts, src/coordinator/operations-query-workflow.ts, src/store/sqlite/card-context-store.ts, src/cards/run-card.ts, src/cards/worker-main-card.ts, src/cards/topic-pane-directory-card.ts, tests/worker-main-view.test.ts, tests/worker-main-card.test.ts, tests/topic-view.test.ts, tests/topic-pane-directory-card.test.ts, tests/card-context-boundary.integration.test.ts |
| Exclusions | Git worktree lifecycle, schema migration, deployment, transport changes, unrelated card families. |
| Isolation | Serial/shared authoritative worktree; no external effects. |
| Concurrency conflicts | None |
| Verification seam | Focused reducer/card renderer/context tests plus repository-native typecheck/build/architecture checks. |
| Host capacity | Main-local or one direct worker; live capacity rechecked. |
| Direct-child boundary | `delegation_allowed = false`; no delegation, staging, commits or deployment by child. |
| Acceptance criteria and verification | Branch/worktree appears from authoritative lease state; mutable session identity updates change the owning view version once and reserve one card update; stale/identical identity does not reserve duplicate updates; focused tests and full suite pass. |
| Verification commands | `npx vitest run tests/worker-main-view.test.ts tests/worker-main-card.test.ts tests/topic-view.test.ts tests/topic-pane-directory-card.test.ts tests/card-context-boundary.integration.test.ts tests/run-card.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 6 files / 167 tests passed; typecheck, build, architecture check and diff check passed. |
| Commits | `6607092b` |

## Wave W2: `T2`

### - [x] T2: Remove terminal Workers from active summaries

| Field | Content |
| --- | --- |
| What to build | Refine bounded Worker summary selection so completed/failed/cancelled Workers with no runnable task leave active lists while Worker Main recent history remains available; ensure completion and termination invalidations refresh cards. |
| Spec references | SCN-3, SCN-4 |
| Dependencies | T1 |
| Delegation eligibility | Bounded SQL selector and lifecycle projection with integration tests. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `domain/card-context-summary.ts`, `store/sqlite/card-context-store.ts`, Worker lifecycle invalidation path and worker summary/card tests. |
| Mutation ownership | src/domain/card-context-summary.ts, src/store/sqlite/card-context-store.ts, src/store/sqlite/worker-turn-store.ts, tests/card-context-boundary.integration.test.ts, tests/topic-pane-directory-card.test.ts, tests/worker-main-view.test.ts, tests/worker-main-card.test.ts |
| Exclusions | Deleting durable Worker Tasks, closing panes, changing Worker Thread retention, external Feishu repair. |
| Isolation | Serial/shared authoritative worktree; no external effects. |
| Concurrency conflicts | None |
| Verification seam | Selector unit tests and card-context integration tests prove active filtering, queue reactivation, completed-history retention and idempotent invalidation. |
| Host capacity | Main-local or one direct worker; live capacity rechecked. |
| Direct-child boundary | `delegation_allowed = false`; no delegation, staging, commits or deployment by child. |
| Acceptance criteria and verification | Completed subagents are absent from active summaries; queued/running/blocked remain; recent history is retained; status updates reserve one current card update; focused tests and full suite pass. |
| Verification commands | `npx vitest run tests/card-context-boundary.integration.test.ts tests/topic-pane-directory-card.test.ts tests/worker-main-view.test.ts tests/worker-main-card.test.ts tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 5 files / 577 tests passed; typecheck, build, architecture check and diff check passed. |
| Commits | `bef528a3` |

## Wave W3: `T3`

### - [x] T3: Project bounded model usage and wait statistics

| Field | Content |
| --- | --- |
| What to build | Add a bounded ModelUsageSnapshot projection for model, context remaining, available token counts and observed queue/first-visible/completion timings; show it in relevant Primary/Worker cards and status diagnostics. |
| Spec references | SCN-5 |
| Dependencies | T1, T2 |
| Delegation eligibility | Bounded observability projection with pure reducer and card/status seams; no credentials or external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Extend transcript/topic/Worker projection boundaries and application presentation; retain provider values only when explicitly reported and render unavailable fields as `—`. |
| Mutation ownership | src/domain/topic-view.ts, src/domain/worker-main-view.ts, src/runtime/herdr-events/event-projector.ts, src/cards/run-card.ts, src/cards/worker-main-card.ts, src/store/sqlite/card-context-store.ts, tests/topic-view.test.ts, tests/worker-main-view.test.ts, tests/worker-main-card.test.ts, tests/run-card.test.ts |
| Exclusions | Provider-specific queue APIs, guessed token counts, external metrics systems, schema migration, deployment. |
| Isolation | Serial/shared authoritative worktree after T1/T2; no external effects. |
| Concurrency conflicts | None |
| Verification seam | Reducer tests, card/status rendering tests, typecheck/build/architecture and full suite. |
| Host capacity | One direct-child slot; live capacity rechecked. |
| Direct-child boundary | `delegation_allowed = false`; no delegation, staging, commits or deployment by child. |
| Acceptance criteria and verification | Reported model/context/wait values appear bounded and update idempotently; absent provider data is unavailable; no guessed token counts; focused and full verification pass. |
| Verification commands | `npx vitest run tests/topic-view.test.ts tests/worker-main-view.test.ts tests/run-card.test.ts tests/worker-main-card.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 4 files / 158 tests passed; typecheck, build, architecture check and diff check passed; unavailable provider fields remained null. |
| Commits | `6c005e20` |

## Final delivery checks

After Gate 3, main integrates and commits each ticket atomically, then runs the
affected suites, `npm run typecheck`, `npm run build`, `npm run architecture:check`,
`npm test`, and `git diff --check`. Delivery review must inspect both identity
propagation and Worker lifecycle filtering before any merge or deployment.

## Delivery repair evidence

The delivery review found and the main thread repaired four production-path gaps
with separate atomic commits:

| Commit | Repair | Focused evidence |
| --- | --- | --- |
| `6a5298c0` | Reset turn-scoped model-usage timing across sequential turns while preserving duplicate-start idempotence. | `tests/topic-view.test.ts` (25 passed), typecheck |
| `0d5ff9c5` | Project Worker model and durable queued/completed/wait timestamps from card-context state into Worker Main usage. | Card-context, Worker Main, and topic focused suites (76 passed), typecheck |
| `82256ead` | Carry Worker lease cwd/worktree/branch into `/panes` directory entries through the read-only query port. | `tests/topic-pane-directory-workflow.test.ts` (5 passed), typecheck |
| `4fbd47db` | Apply goal changes arriving in `PaneOutputObserved` to the Primary session projection and interactive Main-card scheduling. | `tests/event-card-integration.test.ts -t "persists a session-owned Goal"`, typecheck |
| `e0fdbf91` | Preserve bounded queued timestamps for prompts admitted behind an active turn, so FIFO wait/first-visible durations use the actual enqueue time. | `tests/topic-view.test.ts` (26 passed), typecheck |
| `7caddf6c` | Resolve Primary workspace/branch from the pane checkout during Herdr reconciliation and propagate it through typed `PaneOutputObserved` identity updates. | Herdr reconciler, event-card, and resolver suites (95 passed), typecheck |
| `2892b4b8` | Remove deployment `BRANCH … · BUILD …` metadata from Turn Cards while retaining the public render option for compatibility. | Turn-card, CardKit presentation, and run-card suites (125 passed), typecheck |
