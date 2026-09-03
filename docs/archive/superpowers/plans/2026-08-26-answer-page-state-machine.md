# Durable Answer Page State Machine Implementation Plan

> **For agentic workers:** Implement this plan task-by-task using test-driven development. This session executes inline because sub-agent delegation is disabled.

**Goal:** Make `answer_pages` the authoritative, crash-recoverable state machine for every CardKit Answer page and use one convergence workflow for live and startup delivery.

**Architecture:** A pure planner decides the next page action from a RunCard and authoritative page state. `AnswerPageWorkflow` repeatedly asks a narrow store for durable state and reserves exactly one atomic outbox transition at a time. `SqliteBindingStore` owns compare-and-set page transitions plus outbox insertion; the projector and startup converger only request convergence.

**Tech Stack:** TypeScript 5.9, Node.js ESM, SQLite via better-sqlite3, Vitest, Lark CardKit.

**Spec:** `docs/superpowers/specs/2026-08-26-answer-page-state-machine-design.md`

**Ticket:** `docs/superpowers/tickets/2026-08-26-answer-page-state-machine.md`

## Global Constraints

- Keep `ANSWER_STREAM_PAGE_LIMIT` at 9,000 characters.
- Do not change CardKit typewriter configuration.
- Do not change scheduler retry, health degradation, worktree resolution, prompt dispatch, steering, or Herdr observation behavior.
- Persist page transition, RunCard compatibility mirror, and corresponding outbox intent in one SQLite transaction.
- Never patch a frozen or finished page.
- Never replay a TraeX prompt as part of delivery recovery.
- Preserve all unrelated working-tree changes.

---

### Task 1: Deterministic Answer Page Planner

**Files:**
- Create: `src/domain/answer-page-plan.ts`
- Test: `tests/answer-page-plan.test.ts`
- Use: `src/runtime/answer-stream.ts`

**Interfaces:**
- Consumes: `RunCardView`, `AnswerPage`, `renderAnswerStreamPage()`, `answerStreamContent()`.
- Produces: `planAnswerPage(view, page, pendingKinds): AnswerPagePlan` and the `AnswerPagePlan` union from the spec.

- [x] Write planner tests for waiting on a creating page, content reservation, terminal finish, continuation, empty terminal answers, and fenced Markdown boundaries.
- [x] Run `npx vitest run tests/answer-page-plan.test.ts` and verify the new module failure.
- [x] Implement the pure planner with no database, clock, logger, or transport dependencies.
- [x] Run `npx vitest run tests/answer-page-plan.test.ts` and verify all planner cases pass.

### Task 2: Atomic Store Transitions

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/domain/types.ts` if a transition result type is required
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/store/sqlite-records.ts` only if persisted fields change
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: planner actions and existing outbox schema.
- Produces: `AnswerPageStore`, `reserveAnswerContent`, `reserveAnswerContinuation`, and `reserveAnswerFinish` semantic operations. Each returns `reserved`, `waiting`, or `stale`.

- [x] Add tests proving sequence reservation and `stream_content` insertion are atomic and idempotent.
- [x] Add tests proving continuation finish, creating-page row, and create intent commit together.
- [x] Add tests proving terminal finish is unique and stale page identities cannot mutate the active page.
- [x] Add a rollback test using an induced insert failure and verify neither page nor RunCard mirror advances.
- [x] Implement compare-and-set transactions and stable idempotency keys in `SqliteBindingStore`.
- [x] Stop `saveRunCard()` from authoritatively transitioning existing Answer pages; retain only safe compatibility initialization/mirroring.
- [x] Update delivery checkpoints to target the exact page encoded in the outbox payload and preserve monotonic states.
- [x] Run `npx vitest run tests/sqlite-store.test.ts`.

### Task 3: Answer Page Convergence Workflow

**Files:**
- Create: `src/coordinator/answer-page-workflow.ts`
- Test: `tests/answer-page-workflow.test.ts`
- Modify: `src/domain/ports.ts`

**Interfaces:**
- Consumes: `AnswerPageStore`, planner, pure Answer card renderer, and `OutboundWorkNotifier`.
- Produces: `AnswerPageWorkflowPort` with `converge(promptId: string): Promise<void>`.

- [x] Write workflow tests for no card identity, existing pending intent, one-page streaming, terminal finish, and serialized convergence.
- [x] Implement idempotent convergence that reserves one durable action per pass and wakes the outbox only after commit.
- [x] Add structured transition logs containing identifiers and outcomes but no answer or card payload.
- [x] Run `npx vitest run tests/answer-page-workflow.test.ts`.

### Task 4: Replace Live and Startup Pagination Paths

**Files:**
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/coordinator/startup-view-converger.ts`
- Modify: `src/events/lark-outbox-dispatcher.ts`
- Modify: `src/main.ts`
- Test: `tests/event-card-integration.test.ts`
- Test: `tests/startup-view-converger.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`

**Interfaces:**
- Consumes: `AnswerPageWorkflowPort.converge(promptId)`.
- Produces: one shared live/restart convergence path; dispatcher checkpoint callback wakes that path.

- [x] Change projector tests to inject the Answer Page workflow and verify scheduling calls convergence.
- [x] Add a startup test where a completed answer has missing stream intent and verify startup reserves it.
- [x] Remove duplicate pagination and sequence mutation from projector and startup converger.
- [x] Wire one `AnswerPageWorkflow` instance through the composition root and dispatcher checkpoint callback.
- [x] Run `npx vitest run tests/event-card-integration.test.ts tests/startup-view-converger.test.ts tests/lark-outbox-dispatcher.test.ts`.

### Task 5: Crash-Recovery Integration Matrix

**Files:**
- Create: `tests/answer-page-recovery.integration.test.ts`
- Modify: `tests/event-card-integration.test.ts` only for obsolete duplicated assertions

**Interfaces:**
- Consumes: real SQLite store, workflow, outbox dispatcher, fake Lark adapter.
- Produces: durable evidence for restart behavior at external delivery boundaries.

- [x] Add a three-page test that repeatedly reconstructs workflow/dispatcher instances between page transitions.
- [x] Cover durable intent recovery, continuation reservation, CardKit entity checkpoint reuse, idempotent reply retry, new-page activation, stale-page dismissal, and terminal delivery across recovery and dispatcher tests.
- [x] Assert complete canonical source coverage, stable logical card count, immutable frozen pages, and per-page sequence arrays beginning at one and strictly increasing.
- [x] Run `npx vitest run tests/answer-page-recovery.integration.test.ts`.

### Task 6: Documentation and Verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-reference.md` if it describes the mirrored RunCard fields as authoritative

**Interfaces:**
- Consumes: implemented behavior.
- Produces: implementation-backed operational documentation.

- [x] Update the Answer streaming section to name `AnswerPageWorkflow` and the atomic reservation/checkpoint boundary.
- [x] Run `rg -n "answer_pages|AnswerPageWorkflow|answerSequence|answerPageIndex" docs src` and remove contradictory active documentation.
- [x] Run focused tests: `npx vitest run tests/answer-page-plan.test.ts tests/answer-page-workflow.test.ts tests/answer-page-recovery.integration.test.ts tests/answer-stream.test.ts tests/event-card-integration.test.ts tests/startup-view-converger.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts`.
- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Inspect `git diff --check`, `git diff --stat`, and the exact changed-file list before committing.
- [x] Commit only Answer Page state-machine files, preserving unrelated worktree changes.
- [x] Rebuild, restart with `herdr plugin action invoke restart --plugin herdr-lark-bridge`, then verify readiness, build identity, bounded plugin logs, and production database invariants.
