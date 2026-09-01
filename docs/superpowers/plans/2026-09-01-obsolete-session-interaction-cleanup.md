# Obsolete Session Interaction Cleanup Implementation Plan

**Goal:** Repair durable Session-card execution and remove dead interactive
paths that cannot run under the FIFO-only TraeX contract.

**Architecture:** The More Actions interaction remains the one durable
authorization for its controls and child forms. The Session-operation dispatcher
remains the only mutating card-action executor. Unsupported historical callbacks
fail closed at the card boundary; schema compatibility values stay readable.

**Tech Stack:** TypeScript ESM, Node.js SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-obsolete-session-interaction-cleanup-design.md`

## Global Constraints

- Never replay Session work that may have reached Herdr.
- Keep SQLite acceptance and interaction consumption in one transaction.
- Do not remove persisted legacy enum values solely because new UI no longer emits them.
- Preserve the rejected automatic-steering recovery path that creates a normal FIFO task.

### Task 1: Repair the More Actions authorization chain

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/session-operation-workflow.test.ts`

- [ ] Accept an active `more_actions` interaction in the existing Session
  acceptance transaction while retaining actor, generation, pane, terminal,
  expiry, and idempotency checks.
- [ ] Change the Session workflow fixture to create the same interaction kind
  that `open_more_actions` produces.
- [ ] Add a regression assertion that an incompatible interaction kind remains
  stale and cannot create a Session operation.

### Task 2: Narrow Session card controls to executable behavior

**Files:**
- Modify: `src/cards/interaction-card.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Modify: `tests/card-interaction-integration.test.ts`
- Modify: `tests/run-card.test.ts`

- [ ] Remove the unsupported model control from newly rendered More Actions cards.
- [ ] Handle historical `session_model` callbacks with a warning and no durable
  Session operation.
- [ ] Remove direct workflow dependencies made obsolete by the Session dispatcher
  and eliminate unused synthetic-message code.
- [ ] Test a real More Actions callback through a real Session workflow and
  verify that it persists exactly one operation.

### Task 3: Remove unreachable supplement and conversion execution paths

**Files:**
- Modify: `src/cards/interaction-card.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/card-interaction-integration.test.ts`
- Modify: `tests/run-card.test.ts`
- Modify: `tests/sqlite-store.test.ts`

- [ ] Remove the supplement renderer and active supplement/queued-conversion
  execution methods.
- [ ] Keep callbacks from old supplement and conversion cards fail-closed.
- [ ] Remove the unreachable forced-parent steering insertion branch.
- [ ] Retain automatic-steering failure recovery and persisted schema values.

### Task 4: Archive stale compatibility/cutover records and verify

**Files:**
- Move: stale standalone cutover and first-run setup plans/specs that reference
  removed plugin or migration surfaces into `docs/archive/superpowers/`

- [ ] Move only records now superseded by standalone-only operation.
- [ ] Run focused tests, `tsc` with unused checks, `npm run typecheck`,
  `npm test`, `npm run build`, and `git diff --check`.
