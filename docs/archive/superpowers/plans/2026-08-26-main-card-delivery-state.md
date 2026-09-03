# Durable Main Card Delivery State Implementation Plan

> **For agentic workers:** Implement inline and preserve unrelated dirty-worktree changes.

**Goal:** Make Main Card projection and delivery crash-recoverable through durable versions and atomic outbox intent.

**Architecture:** `TopicViewState` owns desired and delivered versions. `MainCardWorkflow` is the shared live/startup/checkpoint convergence path, while SQLite owns atomic projection, reservation, and checkpoint transitions.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, Lark CardKit durable outbox.

**Spec:** `docs/superpowers/specs/2026-08-26-main-card-delivery-state-design.md`

## Global Constraints

- Preserve unrelated worktree changes.
- Do not change Answer Page pagination or typewriter settings.
- Do not change prompt dispatch, steering, or Herdr authority.

### Task 1: Durable TopicView versions

**Files:** `src/domain/topic-view.ts`, `tests/topic-view.test.ts`

- [ ] Add zero-defaulted `viewVersion` and `deliveredVersion`.
- [ ] Increment desired version only for visible reducer changes.
- [ ] Verify duplicate/no-op events do not advance it.

### Task 2: Atomic store transitions

**Files:** `src/domain/ports.ts`, `src/store/sqlite-store.ts`, `tests/sqlite-store.test.ts`

- [ ] Add atomic TopicView-plus-intent reservation.
- [ ] Keep initial creation immutable and unique while pending.
- [ ] Advance delivery checkpoints monotonically.
- [ ] Add rollback, idempotency, and legacy-load tests.

### Task 3: Shared convergence workflow

**Files:** `src/coordinator/main-card-workflow.ts`, `src/events/lark-outbox-dispatcher.ts`, `tests/main-card-workflow.test.ts`, `tests/lark-outbox-dispatcher.test.ts`

- [ ] Serialize convergence per binding.
- [ ] Emit Main Card checkpoint hints after committed delivery.
- [ ] Verify repeated/concurrent convergence is idempotent.

### Task 4: Live and startup integration

**Files:** `src/events/conversation-view-projector.ts`, `src/coordinator/startup-view-converger.ts`, `src/main.ts`, integration tests

- [ ] Replace in-memory Main Card versions with durable projection intent.
- [ ] Replace unconditional startup updates with shared convergence.
- [ ] Preserve current worktree and passive-terminal projections.

### Task 5: Documentation, verification, and rollout

- [ ] Update `docs/architecture.md`.
- [ ] Run focused and full tests, typecheck, build, and diff checks.
- [ ] Commit only Main Card files using hunk staging for mixed files.
- [ ] Build from the exact commit, restart through the Herdr plugin, and verify identity, readiness, logs, and database invariants.
