# Degraded Status Convergence Implementation Plan

> **For agentic workers:** Implement inline; sub-agent delegation is not authorized for this repository task.

**Goal:** Resolve actionable degraded state without deleting delivery history or replaying TraeX work.

**Architecture:** Add a narrowly-scoped transactional startup repair in the SQLite store, invoke it from startup view convergence, and terminalize only provisioning records whose pane absence is authoritative. Existing health semantics remain strict.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, Herdr CLI, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-28-degraded-status-convergence-design.md`

## Global Constraints

- Preserve all dead-letter and quarantine audit rows.
- Never replay a TraeX prompt.
- Bound automatic immutable delivery recovery to one additional startup attempt.
- Do not alter unrelated active quarantines.
- Preserve unrelated worktree changes.

### Task 1: Durable quarantine convergence

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

- [x] Add failing tests for recoverable Answer creation and obsolete disconnected-topic notice.
- [x] Add `recoverStaleOutboxQuarantines()` as one SQLite transaction.
- [x] Verify unrelated quarantine rows remain active.

### Task 2: Startup integration

**Files:**
- Modify: `src/coordinator/startup-view-converger.ts`
- Test: `tests/startup-view-converger.test.ts`

- [x] Add a failing test that startup recovery wakes reopened outbound work.
- [x] Invoke quarantine recovery before durable view projection.

### Task 3: Terminalize missing-pane provisioning

**Files:**
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Test: `tests/provisioning-recovery.test.ts`

- [x] Add a failing test for a confirmed missing pane at `pane_created`.
- [x] Mark the selection and binding failed only for confirmed absence.
- [x] Preserve processing state for ambiguous identity and transport failures.

### Task 4: Verification and deployment

- [x] Run focused tests for store, startup convergence, provisioning, dispatcher, and health.
- [x] Run `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Restart through the Herdr plugin.
- [ ] Verify `/health`, `/ready`, `/status`, startup recovery, and SQLite state.

### Task 5: Bounded canonical content recovery

**Files:**
- Modify: `src/runtime/answer-stream.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/answer-page-plan.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/answer-page-plan.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`

**Interfaces:**
- Consumes: an exhausted transient `stream_content`, its active `AnswerPage`, and canonical `RunCardView` content
- Produces: one `startup-lite-content:<failed-reply-id>` replacement with `sourceEnd`, followed by either an exact continuation or terminal finish

- [ ] Add a store regression that exhausts a transient active-page content reply and asserts one 4,000-character-or-smaller canonical replacement, spent recovery budget, preserved dead letter, released quarantine, and restart idempotency.
- [ ] Add a dispatcher regression proving a permanent content rejection remains actively quarantined and emits no Answer checkpoint or continuation.
- [ ] Add planner regressions for a delivered recovery chunk whose `sourceEnd` is before canonical EOF and one whose `sourceEnd` equals canonical EOF.
- [ ] Persist `sourceEnd` in delivery facts and continue only when it is strictly before canonical EOF; otherwise reserve terminal finish on the same page.
- [ ] Run `npx vitest run tests/answer-page-plan.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts tests/answer-page-workflow.test.ts tests/answer-page-recovery.integration.test.ts`.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`, then commit only the Answer recovery files.
- [ ] Build the exact commit, restart through the Herdr plugin, and verify `ready`, `status`, outbox lanes, active quarantines, and the recovered page's durable terminal or continuation state.
