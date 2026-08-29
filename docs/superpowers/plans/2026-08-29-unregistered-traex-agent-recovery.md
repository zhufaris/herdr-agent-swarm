# Unregistered TraeX Agent Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a live TraeX pane that is absent from Herdr's Agent registry, show a durable degraded recovery state, and allow its creator to reset the topic onto a verified replacement Agent without replaying work.

**Architecture:** `HerdrRuntimeReconciler` classifies native dispatchability from the merged Herdr snapshot. A new `BindingDegraded` lifecycle event and one SQLite transaction persist the degraded attachment, topic projection, and Main Card outbox intent together. Existing reset provisioning and atomic cutover remain the only recovery mutation.

**Tech Stack:** TypeScript ESM, Node.js 22+, SQLite, Vitest, Herdr CLI 0.7.5, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-29-unregistered-traex-agent-recovery-design.md`

## Global Constraints

- Never use raw Pane input as an ordinary-prompt fallback.
- Never restart, terminate, or send input to a legacy unregistered Pane automatically.
- Never replay a failed or possibly delivered prompt.
- Persist binding state, topic projection, and Lark outbox intent atomically.
- Fence runtime mutations by binding ID, Pane ID, and generation.
- Verify a replacement through compatible Herdr Agent registration before cutover.
- Deploy only to the configuration that owns the affected Lark App, chat, and SQLite database.

---

### Task 1: Durable unregistered-Agent degradation

**Files:**
- Modify: `src/domain/events.ts`
- Modify: `src/domain/topic-view.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: `tests/topic-view.test.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `HerdrPane.agentKind`, `HerdrPane.agentState`, `HerdrPane.foregroundExecutables`, and the existing binding generation fence.
- Produces: `BindingDegraded { reason: string }` and `degradeBindingWithProjection(input): RuntimeDegradationResult`.

- [ ] **Step 1: Write failing reducer, store, and reconciler tests**

Add tests that assert a pane with `foregroundExecutables: ["traex"]`, `agentKind: null`, and `agentState: "unknown"` becomes `attachment: "degraded"`, keeps `state: "active"`, persists a topic view with `phase: "degraded"`, and reserves exactly one Main Card update. Repeating the same observation must not add another outbox row. Add a second observation containing `agentKind: "codex"` and `agentState: "idle"`; it must restore `attachment: "attached"`.

- [ ] **Step 2: Run focused tests and confirm the new assertions fail**

Run: `npx vitest run tests/topic-view.test.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts`

Expected: failures because `BindingDegraded`, the `degraded` topic phase, and the atomic degradation method do not yet exist.

- [ ] **Step 3: Implement the minimal durable transition**

Extend the event union with:

```ts
| EventBase<"BindingDegraded", { reason: string }>
```

Extend `TopicViewPhase` with `"degraded"` and reduce that event to the supplied notice. Add a store method that, inside `BEGIN IMMEDIATE`, verifies `(bindingId, expectedPaneId, expectedGeneration)`, transitions with one non-confirmed `pane_probe_failed`, saves the supplied topic view, reserves the supplied Main Card, commits, and returns whether the outbox was reserved. If the binding is already degraded with the same projected view, return unchanged without duplicating outbox intent.

In reconciliation, before `applyRuntimeObservation`, classify a bound TraeX pane as unregistered when `agentKind` is neither `codex` nor `traex`. Persist `BindingDegraded` through the atomic store method, wake outbound work when reserved, log `reason: "agent_unregistered"`, and skip Agent-state/output publication for that pass. A later compatible Agent observation follows the existing `applyRuntimeObservation` path and restores attachment.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run: `npx vitest run tests/topic-view.test.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts`

Expected: all selected files pass.

- [ ] **Step 5: Commit the durable degradation slice**

```bash
git add src/domain/events.ts src/domain/topic-view.ts src/domain/types.ts src/domain/ports.ts src/store/sqlite-store.ts src/coordinator/herdr-runtime-reconciler.ts tests/topic-view.test.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts
git commit -m "fix: degrade unregistered TraeX agents"
```

### Task 2: Degraded-session recovery controls

**Files:**
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/interaction-card.ts`
- Modify: `docs/feishu-group-usage.md`
- Test: `tests/pane-thread-lifecycle-integration.test.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: an active binding with `attachment: "degraded"` and the existing `createResetCandidate` / `cutoverResetCandidate` transaction.
- Produces: creator-only `/swarm reset` and `session_reset` recovery for degraded bindings; no new provisioning path.

- [ ] **Step 1: Write failing command and CardKit tests**

Add an integration test whose original binding is `active/degraded` and whose old pane is an unregistered live TraeX pane. Invoke `/swarm reset`, verify one replacement pane is created, require the replacement observation to contain `agentKind: "codex"` and `agentState: "idle"`, and assert the topic cuts over while the old pane is not closed. Add card tests asserting degraded Main Cards show the exact recovery notice and More Actions exposes `session_reset` to the creator but not non-creators.

- [ ] **Step 2: Run focused tests and confirm the new assertions fail**

Run: `npx vitest run tests/pane-thread-lifecycle-integration.test.ts tests/run-card.test.ts`

Expected: reset is rejected for `attachment: "degraded"` and the card phase/action is missing.

- [ ] **Step 3: Enable only the existing safe reset path**

Change the reset eligibility check from `attachment === "attached"` to `attachment === "attached" || attachment === "degraded"`. Keep creator authorization, candidate creation, native Agent verification, cutover, queued cancellation, uncertain observer detachment, and retired-pane cleanup unchanged. Render degraded status as an orange recovery state and include reset in creator More Actions. Document `/swarm reset` as the recovery for a live but unregistered TraeX pane.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run: `npx vitest run tests/pane-thread-lifecycle-integration.test.ts tests/run-card.test.ts`

Expected: all selected files pass and no old-pane prompt/input method is called.

- [ ] **Step 5: Commit the recovery-control slice**

```bash
git add src/coordinator/binding-provisioning-workflow.ts src/cards/run-card.ts src/cards/interaction-card.ts docs/feishu-group-usage.md tests/pane-thread-lifecycle-integration.test.ts tests/run-card.test.ts
git commit -m "fix: reset degraded TraeX bindings"
```

### Task 3: Full verification and owning-instance deployment

**Files:**
- Verify: all modified source and test files
- Inspect only: the owning process environment, SQLite database, and Herdr pane registry

**Interfaces:**
- Consumes: the two committed implementation slices and the service lifecycle command for the port-8787 legacy plugin configuration.
- Produces: a running owning instance whose observed build identity matches the committed build.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, typecheck exits zero, and the generated build identity names the current commit.

- [ ] **Step 2: Inspect production safety gates before restart**

Against the database path from the port-8787 process environment, query queued/running prompts, active instance turns, pending outbox rows, lease owner, and SQLite `quick_check`. Confirm no prompt or delivery is in flight. Confirm the process still owns the expected Lark App/chat without printing secrets.

- [ ] **Step 3: Restart only the owning legacy plugin instance**

Use the Herdr plugin lifecycle action associated with `HERDR_PLUGIN_CONFIG_DIR=/home/feiyu.zhu/.config/herdr/plugins/config/herdr-lark-bridge`. Do not restart `herdr-agent-swarm.service` on port 8788 and do not terminate `wH:p5Z`.

- [ ] **Step 4: Verify deployed convergence**

Confirm the port-8787 `/ready` endpoint, expected/observed build identity, lease, SQLite integrity, zero pending outbox, and the `task-ulqf` binding's durable degraded state and Main Card update. Confirm `wH:p5Z` still exists and remains absent from `herdr agent list`.

- [ ] **Step 5: Recover the topic without prompt replay**

Have the binding creator invoke `/swarm reset` in `task-ulqf`. Verify the replacement Pane is present in `herdr agent list`, the topic binding points to it, the old binding is archived, no old failed prompt was requeued, and the old `wH:p5Z` was retained because its native Agent state was unknown.
