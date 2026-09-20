# Pane-scoped Worker lifecycle implementation plan

> **For agentic workers:** Execute this plan inline. This repository session explicitly forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Worker a non-restartable session derived from one exact Primary pane, and close all derived Worker panes when the parent Primary pane is confirmed closed.

**Architecture:** SQLite persists Worker history, parent identity, terminalization intent, and close-operation recovery. Herdr remains authoritative for pane existence and identity. A parent pane close persists the Worker cascade before invoking Herdr effects; Worker turns are terminalized without replay, then recorded Worker panes are closed, then the parent binding/pane is closed. A retained worktree remains removable user state, never a way to rehydrate the prior Worker session.

**Tech Stack:** TypeScript, Node.js 22+, SQLite, Vitest, Herdr CLI/socket adapter, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-09-04-pane-scoped-worker-lifecycle-design.md`

## Global constraints

- Do not attach, adopt, or close any unrecorded Herdr pane.
- A Worker session is never re-created in a replacement pane.
- Once a Worker turn may have reached TraeX, closing or pane loss must never return it to `queued` or invoke the driver again.
- Persist cascade intent and terminal turn state before each external `closePane` effect. Do not replay an uncertain external close command after restart.
- Legacy Worker rows remain inspectable/removable, but are non-startable and do not join a parent cascade.
- Preserve existing user worktrees and the explicit safe-removal workflow. Do not remove a worktree as part of a pane cascade.
- Do not edit generated `dist/` output or include unrelated current worktree modifications.

---

### Task 1: Add parent-pane identity and terminal Worker-session state

**Files:**

- Modify: `src/domain/agent-instance.ts`
- Modify: `src/store/instance-records.ts`
- Modify: `src/domain/ports/instance.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/agent-instance.test.ts`

**Interfaces:**

- Add `WorkerParentIdentity = { bindingId: string; paneId: string; nativeSessionId: string | null }`.
- Add `terminated` to `ObservedInstanceState`; retain `detached` only for temporary observation uncertainty when the recorded pane may still exist.
- Add nullable parent identity columns to `agent_instances`: `parent_binding_id`, `parent_pane_id`, and `parent_native_session_id`; keep `source_primary_pane_label` as display-only history.
- Extend Worker creation input so new Worker rows require parent identity; Primary/legacy rows omit it.
- Add store queries/commands needed by the cascade: list Workers by exact parent binding/pane, atomically terminalize a Worker and its turns, and atomically mark a Worker close effect requested or uncertain.

- [ ] **Step 1: Define state and identity contracts with failing domain tests**

Make a Worker’s parent identity explicit in the persisted record and mandatory in the `role: "worker"` creation path. Define terminalization as one-way: `terminated` has no runtime/pending runtime and cannot accept dispatchable work. Primary and existing legacy records remain representable without parent identity.

- [ ] **Step 2: Add a schema migration with explicit legacy classification**

Introduce the columns in a numbered idempotent migration. Mark existing Worker rows without the new parent identity as legacy/non-startable through a durable predicate or explicit lifecycle marker. Do not infer a parent from `source_primary_pane_label`. Add fresh and upgrade-database tests proving old rows survive intact and cannot join a new parent relationship.

- [ ] **Step 3: Implement atomic Worker terminalization**

In one SQLite transaction, fence the Worker generation, clear runtime references, mark the Worker terminal, and terminalize every turn of that generation:

- `queued` becomes `cancelled` because the Worker session ended before dispatch.
- `claimed`, `dispatching`, `running`, and `blocked` become `dispatch-uncertain` because delivery may have begun.
- `dispatch-uncertain` and terminal turns remain non-replayable.

Preserve Worker turn-card projections through the existing reducer path. Return counts and pane identity for audit/result rendering.

- [ ] **Step 4: Add exact-parent listing and fencing tests**

Cover same-project siblings, Workers from another binding, changed parent pane IDs, stale generations, queued/active turns, idempotent terminalization, and legacy rows. Assert no terminalized turn can be claimed and no association is derived from a display label.

- [ ] **Step 5: Run focused persistence tests**

Run `npx vitest run tests/sqlite-store.test.ts tests/agent-instance.test.ts`. Expected: migration is safe, parent identity is exact, terminalization is atomic, and no Worker turn becomes replayable.

### Task 2: Create Workers only from a live exact parent pane and prevent restarts

**Files:**

- Modify: `src/coordinator/instance-control-workflow.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/cards/instance-control-card.ts`
- Modify: `src/cards/instance-detail-card.ts`
- Test: `tests/instance-control.integration.test.ts`
- Test: `tests/instance-routing.integration.test.ts`

**Interfaces:**

- `createWorker` resolves its `bindingId` to an active attached binding and matching observed parent pane before persisting the Worker.
- Parent identity contains binding ID, exact `binding.paneId`, and normalized parent native session when available.
- `start` is only a first allocation for a non-legacy Worker whose parent still verifies; it is never a restart/rebind operation.

- [ ] **Step 1: Replace label-only lookup with verified identity resolution**

Require `bindingId` for Worker creation. Validate active/attached/project ownership, inspect the recorded pane, and fail closed on missing pane, changed pane, or incompatible/missing terminal/session identity. Persist the display label only after success. Remove the `unbound` title fallback.

- [ ] **Step 2: Restrict start to a live parent and virgin Worker runtime**

Before allocating the Worker pane, re-check parent binding/pane identity. Reject terminated, legacy, detached-after-loss, or any Worker that previously attached a runtime. Retain failed-first-start cleanup only while the original pending Worker pane remains service-owned; do not allocate a replacement pane after confirmed loss.

- [ ] **Step 3: Align Lark cards with the session model**

Only present Worker creation in a valid active binding context. Detail cards show parent metadata. Legacy and terminated Worker cards are historical: omit Start/Restart/Rebind controls, retain inspection and safe-removal controls, and explain that a worktree may remain independently.

- [ ] **Step 4: Add create/start interaction tests**

Cover missing binding context, inactive/orphaned binding, project mismatch, missing parent pane, parent identity change between create and start, normal first start, failed provisioning cleanup, legacy start rejection, and terminated start rejection. Assert no case allocates a replacement pane for an attached Worker.

- [ ] **Step 5: Run focused interaction tests**

Run `npx vitest run tests/instance-control.integration.test.ts tests/instance-routing.integration.test.ts`. Expected: each new Worker has an exact parent and terminal/legacy Workers expose no restart path.

### Task 3: Terminalize Worker sessions on authoritative runtime loss

**Files:**

- Modify: `src/coordinator/instance-runtime-reconciler.ts`
- Modify: `src/events/instance-work-scheduler.ts`
- Modify: `src/coordinator/worker-turn-observer.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Test: `tests/instance-runtime-reconciler.test.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/instance-turn-supervisor.test.ts`

**Interfaces:**

- Missing/mismatched recorded Worker panes invoke atomic terminalization, not `detachAgentInstanceRuntime`.
- Scheduler and observer paths treat `terminated` as non-dispatchable and reject stale post-terminal writes with generation fences.

- [ ] **Step 1: Split temporary uncertainty from confirmed loss**

Keep `detached` only for an observation where a later fresh snapshot can still prove the original runtime. When the authoritative project snapshot lacks the recorded Worker pane or shows identity mismatch, terminalize it.

- [ ] **Step 2: Prevent dispatch and observation after terminalization**

Make claims and scheduler guards require a live non-terminated Worker runtime. Ensure observer updates retain original generation/runtime fences so late transcript/submit callbacks cannot revive a terminal Worker or alter its final card. Preserve shutdown no-replay behavior.

- [ ] **Step 3: Add runtime-loss integration coverage**

Replace expectations for `desiredState: running`, `detached`, and queued-work transfer with terminal session outcomes. Assert missing/mismatched panes terminalize the Worker, cancel queued work, mark active work uncertain, reject start, and leave sibling Workers unaffected. Cover targeted and full snapshots.

- [ ] **Step 4: Run focused runtime tests**

Run `npx vitest run tests/instance-runtime-reconciler.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts`. Expected: no missing Worker pane can reactivate in a new pane and no post-loss dispatch occurs.

### Task 4: Cascade parent-pane close through all derived Workers

**Files:**

- Modify: `src/domain/ports/pane-operations.ts`
- Modify: `src/coordinator/pane-closure-workflow.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/cards/pane-close-card.ts`
- Modify: `src/composition/create-bridge-runtime.ts`
- Test: `tests/pane-close-integration.test.ts`
- Test: `tests/retired-pane-cleanup-workflow.test.ts`
- Test: `tests/service-lifecycle.test.ts`

**Interfaces:**

- Expand `PaneCloseStore` with a durable parent-close cascade/step ledger, scoped to `(bindingId, parentPaneId)`.
- Confirming a parent close remains blocked by active Primary work under the existing safety policy, but never merely by active child Worker work.
- Each child close is issued at most once. Recovery probes Herdr and records `succeeded` on absence or `uncertain` when present; it never sends close again.

- [ ] **Step 1: Persist cascade intent before Herdr effects**

At confirm time, verify Primary binding/pane identity and existing parent safety. In one transaction, discover exact child Workers, terminalize their turns, create a durable close step for each recorded child pane, and fence the parent binding against new Worker creation. Do not touch a Worker whose parent identity does not exactly match captured binding/pane.

- [ ] **Step 2: Execute child-before-parent effects**

Call `closePane` once for every owned child pane and persist the outcome after each call. Then close parent pane. Child close failure does not dispatch turns or undo terminalization; record `uncertain` and continue to the parent close as authorized. Update result card with Worker count, terminalized turns, and uncertain pane IDs.

- [ ] **Step 3: Recover interrupted cascades by observation only**

Reload unresolved parent/child steps at startup. Probe each recorded pane: absent succeeds, present becomes uncertain, identity change becomes uncertain. Never resend `closePane`. Once parent absence is proven, archive binding and retain child terminal records/worktrees.

- [ ] **Step 4: Test confirmation and failure cases**

Cover two children, unrelated sibling, queued child task, active child task, unknown child runtime, one child close failure, parent close failure, and restart recovery. Assert child close calls happen before parent, failure never causes task replay, and unowned panes are untouched. Keep rejection coverage for busy Primary work.

- [ ] **Step 5: Run close/recovery tests**

Run `npx vitest run tests/pane-close-integration.test.ts tests/retired-pane-cleanup-workflow.test.ts tests/service-lifecycle.test.ts`. Expected: confirmation provides a one-shot cascade; recovery observes rather than replays effects; results are auditable.

### Task 5: Refresh documentation and run the full verification gate

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `README.md` where Worker lifecycle is described
- Modify: affected CardKit/operation snapshot tests as needed

- [ ] **Step 1: Update operator-facing lifecycle language**

Document parent-bound Worker sessions, cascading parent close, terminalized child tasks without replay, and the distinction between a retained worktree and a resumable agent.

- [ ] **Step 2: Update architecture ownership/recovery**

Replace the old restartable-detached Worker description with exact parent fencing, durable cascade intent, child-before-parent effects, and observation-only recovery.

- [ ] **Step 3: Execute complete verification**

Run all focused suites from Tasks 1–4, then `npm run typecheck`, `npm run build`, and `npm test`. Run `git diff --check`, stage only task-related files, and make thematic commits for persistence/domain, Worker lifecycle/UI, then parent-close cascade/docs. Do not push unless separately requested.

## Final acceptance checks

- A Worker created under Primary pane A cannot start under a replacement pane after its Worker pane is gone.
- Closing Primary pane A closes exactly its recorded Worker panes and terminalizes their tasks without re-dispatch.
- Workers from pane B, another binding, or another project are untouched by A’s close.
- Restart during a cascade does not issue duplicate `closePane` or a second TraeX prompt.
- Existing Worker records remain readable and safely removable but cannot be rebound from a display label.
