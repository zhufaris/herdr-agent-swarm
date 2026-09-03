# Session Card Action Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every mutating Session card callback durably accepted before it is reported as handled, while preserving each workflow's existing no-replay recovery semantics.

**Architecture:** Every mutating Session callback atomically consumes its interaction and enters the focused `session_operations` inbox. `SessionOperationWorkflow` validates identity and dispatches it once; pane control, reset, archive, and pane-close then continue through their existing durable authorities, while rename, reattach, replace, and resume complete through their existing workflows.

**Tech Stack:** TypeScript ESM, Node.js SQLite, Vitest, existing Herdr and Lark ports.

**Spec:** `docs/superpowers/specs/2026-08-31-session-card-action-durability-design.md`

**Implementation status (2026-08-31):** Tasks 1-4 are implemented with one deliberate simplification: restart recovery conservatively marks every interrupted `running` Session operation `uncertain` instead of attempting action-specific proof. All mutating Session actions use the common inbox before their existing workflow. Task 5 verification is recorded in the implementation handoff rather than by claiming every original red/green planning step was executed exactly as drafted.

## Global Constraints

- SQLite remains the durable workflow authority; Herdr observation remains the runtime authority.
- Never replay an operation after its external side effect may have occurred.
- Persist workflow intent before publishing a wake-up or returning an accepted Toast.
- Keep high-risk approval local to Herdr and preserve the existing pane-close confirmation flow.
- Store no raw Lark event, card JSON, prompt content, terminal output, or secrets in Session operation rows.
- This plan covers Session cards only; Worker and Instance actions are unchanged.
- Do not install, restart, commit, or overwrite the user's standalone cutover document or `TODO.md`.

---

### Task 1: Define Session operation contracts and SQLite schema

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: `SessionOperationKind` for all mutating Session actions.
- Produces: `SessionOperationState = "accepted" | "running" | "succeeded" | "rejected" | "failed" | "uncertain"`.
- Produces: `SessionOperation` with identity fences, bounded `argument`, state, attempt count, detail, and timestamps.
- Produces: `acceptSessionOperation`, `claimNextSessionOperation`, `finishSessionOperation`, `getSessionOperation`, `listRecoverableSessionOperations`, and `pruneTerminalSessionOperations`.

- [ ] **Step 1: Write failing schema and store tests**

Add tests that create a `session_control` interaction and call:

```ts
store.acceptSessionOperation({
  id: "op-1",
  idempotencyKey: "interaction:i1:rename",
  interactionId: "i1",
  actorOpenId: "member",
  bindingId: "b1",
  bindingGeneration: 1,
  expectedPaneId: "p1",
  expectedTerminalId: "t1",
  kind: "rename",
  argument: "New title",
  now: "2026-08-31T00:00:00.000Z"
});
```

Assert the operation is `accepted`, the interaction is `consumed`, a duplicate returns the same operation, and unauthorized/expired/stale inputs leave the interaction active and create no operation. Add claim ordering and identity-fence tests, plus a migration assertion for the new table and indexes.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: compilation or assertion failure because Session operation contracts and schema do not exist.

- [ ] **Step 3: Add domain records and the additive migration**

Create `session_operations` with a unique idempotency key, foreign keys to binding and interaction, constrained kind/state, binding generation, optional pane/terminal fences, bounded argument, attempt count, detail, and timestamps. Add claim indexes ordered by state and creation time. Map rows in `sqlite-records.ts`.

- [ ] **Step 4: Implement atomic acceptance and lifecycle methods**

`acceptSessionOperation` uses `BEGIN IMMEDIATE`, validates the interaction before mutation, inserts with `ON CONFLICT(idempotency_key) DO NOTHING`, and consumes the interaction only when the operation exists. `claimNextSessionOperation` atomically changes `accepted` to `running` only when binding generation and pane identity still match. Terminal updates accept only `running` or `uncertain`.

- [ ] **Step 5: Run store tests**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: all store tests pass.

### Task 2: Make existing workflow acceptance atomic with card consumption

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/pane-control-workflow.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/coordinator/session-administration-workflow.ts`
- Modify: `src/coordinator/pane-closure-workflow.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/card-interaction-integration.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: existing card interaction validation fields.
- Produces: interaction-aware acceptance variants for pane control, reset candidate, archive transition, and pane-close request.
- Produces: explicit outcomes `accepted | duplicate | unauthorized | expired | stale | rejected`.

- [ ] **Step 1: Add crash-window regression tests**

For stop, model, reset, archive, and pane-close request, assert that a forced transaction failure leaves the interaction active and creates neither an operation nor a partial binding transition. Assert a successful call consumes the interaction and creates the durable workflow record or final SQLite state in the same transaction.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/sqlite-store.test.ts tests/card-interaction-integration.test.ts tests/concurrency-controls.integration.test.ts`

Expected: new atomicity assertions fail against the current consume-before-workflow path.

- [ ] **Step 3: Introduce interaction-aware store transactions**

Refactor common interaction validation into a private transaction-local helper. Add dedicated methods rather than nesting transactions: `acceptPaneControlFromInteraction`, `createResetCandidateFromInteraction`, `archiveBindingFromInteraction`, and `createPaneCloseRequestFromInteraction`. Preserve existing message-command methods for non-card callers.

- [ ] **Step 4: Update workflow ports to accept a prevalidated interaction context**

Card callers pass `interactionId`; text-command callers omit it and retain their existing paths. Workflows publish wake-ups and lifecycle events only after the transaction commits. Duplicate callbacks return accepted success without repeating a Herdr call or projection.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/sqlite-store.test.ts tests/card-interaction-integration.test.ts tests/concurrency-controls.integration.test.ts`

Expected: all selected tests pass.

### Task 3: Add the focused Session operation workflow

**Files:**
- Create: `src/coordinator/session-operation-workflow.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Create: `tests/session-operation-workflow.test.ts`
- Modify: `tests/card-interaction-integration.test.ts`

**Interfaces:**
- Consumes: Session operation store methods from Task 1 and existing Session administration/provisioning capabilities.
- Produces: `accept(action, binding, interactionId, kind, argument): SessionOperationAcceptance`.
- Produces: `start()`, `stop()`, `wake(bindingId?)`, `recover()`, and `snapshot()`.

- [ ] **Step 1: Write dispatcher and callback tests**

Test that rename, reattach, replace, and resume callbacks return an accepted Toast after SQLite commit without waiting for a deferred Herdr promise. Test FIFO single-flight execution, coalesced wake-ups, duplicate callbacks, shutdown, and restart handling of accepted work.

- [ ] **Step 2: Add no-replay recovery tests**

Seed `running` operations and fresh Herdr observations. Assert achieved target states become `succeeded`, stale identity becomes `rejected`, and ambiguous states become `uncertain` without invoking rename, attach, or pane creation.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npx vitest run tests/session-operation-workflow.test.ts tests/card-interaction-integration.test.ts`

Expected: failure because the workflow and async acceptance path do not exist.

- [ ] **Step 4: Implement coalescing single-flight dispatch**

Claim accepted operations in creation order. Re-read binding and identity fences before calling the appropriate workflow capability. Mark deterministic validation failures rejected, pre-call failures failed, successful completions succeeded, and errors after the external-call boundary uncertain. Never return `running` to `accepted` without proof that the external call was not attempted.

- [ ] **Step 5: Wire startup, wake-up, and shutdown**

Run recovery before accepting Lark traffic, start the dispatcher after recovery, and stop new claims during shutdown while awaiting the active operation. The Card interaction workflow only validates presentation input and delegates durable acceptance.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/session-operation-workflow.test.ts tests/card-interaction-integration.test.ts tests/concurrency-controls.integration.test.ts`

Expected: all selected tests pass.

### Task 4: Add diagnostics, retention, and architecture documentation

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/health/server.ts`
- Modify: `src/runtime/outbox-retention-maintainer.ts`
- Modify: `src/main.ts`
- Modify: `docs/architecture.md`
- Modify: `tests/health-server.test.ts`
- Modify: `tests/outbox-retention-maintainer.test.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: aggregate Session operation backlog in `OperationalSummary`.
- Produces: dispatcher diagnostics with state, active count, last completion, and bounded failure metadata.
- Produces: terminal Session operation pruning.

- [ ] **Step 1: Write status and retention tests**

Assert `/status` exposes counts and oldest accepted age without arguments or raw errors, marks a five-minute accepted head degraded without changing `/ready`, isolates snapshot failures, and prunes only old `succeeded`, `rejected`, and `failed` rows. Assert `accepted`, `running`, and `uncertain` survive retention.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/health-server.test.ts tests/outbox-retention-maintainer.test.ts tests/sqlite-store.test.ts`

Expected: new diagnostic and pruning assertions fail.

- [ ] **Step 3: Implement aggregate diagnostics and bounded pruning**

Extend the existing operational summary query and health degradation predicate. Add Session operation pruning as an independent retention batch so outbox or inbound volume cannot starve it. Keep all exposed errors bounded and omit operation arguments.

- [ ] **Step 4: Update architecture documentation**

Document atomic Card Action acceptance, workflow-specific durable authorities, the Session operation dispatcher, wake-up versus authority semantics, and no-replay recovery.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/health-server.test.ts tests/outbox-retention-maintainer.test.ts tests/sqlite-store.test.ts`

Expected: all selected tests pass.

### Task 5: Full verification and review

**Files:**
- Review: all files changed by Tasks 1-4

**Interfaces:**
- Consumes: the complete Session Card Action durability implementation.
- Produces: verification evidence only; no deployment or commit.

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all Vitest files and tests pass.

- [ ] **Step 3: Build generated output**

Run: `npm run build`

Expected: exit code 0 and a new generated build identity.

- [ ] **Step 4: Check patch formatting and scope**

Run: `git diff --check` and inspect `git status --short` plus `git diff --stat`.

Expected: no whitespace errors; the existing standalone cutover document and `TODO.md` remain untouched by this implementation.

- [ ] **Step 5: Report without deployment**

Summarize the durability guarantees, tests, build identity, and remaining Worker/Instance scope. Do not install, restart, or commit.
