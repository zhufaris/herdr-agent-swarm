# Herdr Event Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route acknowledged Herdr native events to Pane- or workspace-scoped authoritative reconciliation while retaining periodic full recovery.

**Architecture:** `HerdrSocketSubscriber` owns the socket protocol, acknowledgement lifecycle, event normalization, and bounded hint coalescing. A new `HerdrEventRouter` owns best-effort wake-up policy and calls narrow coordinator methods; coordinators continue to read Herdr and SQLite before applying transitions. Existing startup and periodic scans remain unchanged as the convergence safety net.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Zod, Vitest, the then-supported Herdr release socket protocol, SQLite.

**Spec:** `docs/superpowers/specs/2026-08-31-herdr-event-router-design.md`

## Global Constraints

- Herdr event payloads are bounded wake-up hints, never authoritative workflow state.
- Every state transition must follow a fresh Herdr read and existing SQLite generation and identity fences.
- Keep the 30-second startup/periodic binding, instance, turn, external-turn, and cleanup safety scans.
- Preserve FIFO, steering, uncertain-dispatch/no-replay, CardKit ordering, and attached transcript polling behavior.
- Do not make socket event availability a readiness gate.
- Do not manually edit generated `dist/` output.
- The worktree already contains unrelated and overlapping user changes. Inspect each target diff before editing, use narrow patches, and stage only task-owned hunks.
- Execute inline unless the user explicitly authorizes sub-agents.

## File structure

- Create `src/runtime/herdr-event-hint.ts`: normalized event kinds, explicit scopes, normalization, and merge rules.
- Modify `src/runtime/herdr-socket-subscriber.ts`: acknowledged subscription lifecycle and normalized hint emission.
- Create `src/runtime/herdr-event-router.ts`: best-effort hint-to-reconciliation dispatch policy and diagnostics.
- Modify coordinator and store ports only where a Pane-indexed authoritative lookup is required.
- Keep per-record reconciliation logic in its existing coordinator; do not duplicate state transitions in the router.
- Modify `src/main.ts` only for construction and wiring after all focused components pass tests.

---

### Task 1: Acknowledged and normalized Herdr subscription

**Files:**
- Create: `src/runtime/herdr-event-hint.ts`
- Modify: `src/runtime/herdr-socket-subscriber.ts`
- Test: `tests/herdr-socket-subscriber.test.ts`

**Interfaces:**
- Produces: `HerdrEventKind`, `HerdrEventScope`, `HerdrRuntimeHint`, `normalizeHerdrEvent(event, ids)`, and `mergeHerdrRuntimeHints(current, next)`.
- Produces: `HerdrSocketSubscriber` callbacks emitting `HerdrRuntimeHint`; `status().eventsConnected` means an acknowledged subscription.
- Preserves: `waitForPaneEvent(paneId, timeoutMs)` and the short-lived RPC request API.

- [ ] **Step 1: Write failing normalization and merge tests**

Add cases proving dotted and underscore spellings normalize identically, Pane-only hints retain their Pane IDs, mixed scopes widen deterministically, and unknown or identity-free events use full scope. Use explicit expectations such as:

```ts
expect(normalizeHerdrEvent("pane.agent_status_changed", { workspaceIds: [], paneIds: ["w1:p1"] }))
  .toEqual({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p1"] });
expect(normalizeHerdrEvent("pane_agent_status_changed", { workspaceIds: [], paneIds: ["w1:p1"] }))
  .toEqual(expect.objectContaining({ kind: "agent-status", scope: "panes" }));
expect(mergeHerdrRuntimeHints(paneHint, workspaceHint)).toMatchObject({
  scope: "workspaces", paneIds: ["w1:p1"], workspaceIds: ["w1"]
});
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `npx vitest run tests/herdr-socket-subscriber.test.ts`

Expected: FAIL because normalized hint exports and acknowledged subscription semantics do not exist.

- [ ] **Step 3: Implement the normalized hint module**

Define explicit types and pure normalization/merge functions. Normalize these pairs:

```ts
"pane.agent_status_changed" / "pane_agent_status_changed" -> "agent-status"
"pane.created" / "pane_created" -> "pane-created"
"pane.updated" / "pane_updated" -> "pane-updated"
"pane.closed" / "pane_closed" -> "pane-closed"
"pane.moved" / "pane_moved" -> "pane-moved"
"pane.exited" / "pane_exited" -> "pane-exited"
"pane.agent_detected" / "pane_agent_detected" -> "agent-detected"
```

Use `panes < workspaces < all` for widening. Preserve bounded unique Pane and workspace IDs during merge.

- [ ] **Step 4: Write failing subscription acknowledgement tests**

Extend the fake socket server to assert:

- `eventsConnected` remains false after TCP connect and before ACK;
- the matching success response changes it to true and emits one `socket-recovered` full hint;
- a Herdr error response, malformed ACK, close-before-ACK, and ACK timeout leave it false and schedule reconnect;
- an event received before ACK does not establish subscription health.

- [ ] **Step 5: Implement the subscription state machine**

Add a unique subscription request ID, an acknowledgement timer bounded by the existing command/reconnect timing, and a private state such as:

```ts
type EventConnectionState = "disconnected" | "connecting" | "subscribing" | "subscribed";
```

Handle the subscription response inside the persistent connection rather than the short-lived RPC pending map. Only after a matching valid response may the subscriber reset backoff, log connection/recovery, emit `socket-recovered`, and report `eventsConnected: true`. Ensure every close/error/stop path clears the ACK timer and resolves waiters exactly once.

- [ ] **Step 6: Run focused verification**

Run: `npx vitest run tests/herdr-socket-subscriber.test.ts`

Expected: all subscriber tests pass, including reconnect and Pane waiter behavior.

- [ ] **Step 7: Commit only Task 1 files**

```bash
git add src/runtime/herdr-event-hint.ts src/runtime/herdr-socket-subscriber.ts tests/herdr-socket-subscriber.test.ts
git diff --cached --check
git commit -m "fix: acknowledge Herdr event subscriptions"
```

### Task 2: Event routing policy

**Files:**
- Create: `src/runtime/herdr-event-router.ts`
- Create: `tests/herdr-event-router.test.ts`

**Interfaces:**
- Consumes: `HerdrRuntimeHint` from Task 1.
- Produces: `HerdrEventRouter.handle(hint: HerdrRuntimeHint): Promise<void>` and bounded diagnostics.
- Depends on injected ports for workspace invalidation, binding reconciliation, instance reconciliation, turn observation, external-turn observation, and cleanup retry.

- [ ] **Step 1: Write failing router tests with fake consumers**

Cover these exact policies:

```ts
agent-status + panes -> Pane-targeted consumers only
topology + workspace IDs -> invalidate and reconcile named workspaces
topology + Pane IDs -> also wake Pane turn/external/cleanup consumers
all scope -> full binding, instance, turn, external-turn, and cleanup scans
one consumer failure -> other consumers still run and failure is counted
concurrent equivalent hints -> coalesced without losing identifiers
```

- [ ] **Step 2: Run the router test and confirm it fails**

Run: `npx vitest run tests/herdr-event-router.test.ts`

Expected: FAIL because `HerdrEventRouter` does not exist.

- [ ] **Step 3: Implement the router as a pure orchestration boundary**

Use narrow injected interfaces rather than importing concrete coordinators. A suitable dependency shape is:

```ts
interface HerdrEventRouterOptions {
  invalidateWorkspace(workspaceId: string): void;
  reconcileBindings(scope?: { paneIds?: readonly string[]; workspaceIds?: readonly string[] }): Promise<void>;
  reconcileInstances(scope?: { paneIds?: readonly string[]; workspaceIds?: readonly string[] }): Promise<void>;
  observeInstanceTurns(paneIds?: readonly string[]): Promise<void>;
  observeExternalTurns(paneIds?: readonly string[]): Promise<void>;
  retryRetiredPanes(paneIds?: readonly string[]): Promise<void>;
  logger: Pick<Logger, "warn" | "debug">;
}
```

Use `Promise.allSettled` or individually contained calls so one failed handler cannot suppress other convergence paths. Do not inspect or update SQLite inside the router.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/herdr-event-router.test.ts tests/herdr-socket-subscriber.test.ts`

Expected: all router and subscriber tests pass.

- [ ] **Step 5: Commit only Task 2 files**

```bash
git add src/runtime/herdr-event-router.ts tests/herdr-event-router.test.ts
git diff --cached --check
git commit -m "feat: route scoped Herdr event hints"
```

### Task 3: Pane-targeted agent instance and turn reconciliation

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/instance-runtime-reconciler.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/instance-runtime-reconciler.test.ts`
- Modify: `tests/instance-turn-supervisor.test.ts`

**Interfaces:**
- Produces store lookups `findAgentInstanceByPane(paneId: string): AgentInstance | null` and `listObservableInstanceTurnsByPaneIds(paneIds: readonly string[]): InstanceTurn[]`.
- Produces `InstanceRuntimeReconciler.requestReconciliation(scope?)` and `InstanceTurnSupervisor.requestObservationByPane(paneIds)`.
- Preserves existing `reconcile()` methods as complete safety scans.

- [ ] **Step 1: Write failing SQLite lookup tests**

Create multiple instances and turns on different Pane IDs. Assert Pane-indexed queries return only the current-generation matching instance and observable turns, return no detached runtime, and preserve deterministic ordering.

- [ ] **Step 2: Implement indexed store queries**

Add focused SQL using the existing `agent_instances.pane_id` and current-generation join used by `listObservableInstanceTurns`. Do not add a migration unless `EXPLAIN QUERY PLAN` or the schema shows the existing Pane index is absent and the query would scan materially large tables. If an index is needed, add it through the idempotent schema migration path and test repeated initialization.

- [ ] **Step 3: Write failing targeted reconciler tests**

Assert that:

- targeting `w1:p1` never calls `listPanes` for unrelated projects;
- the instance reconciler inspects only `w1:p1`;
- the turn supervisor observes only turns mapped to `w1:p1`;
- missing/mismatched runtime still detaches using existing identity rules;
- stale-generation writes remain rejected;
- full `reconcile()` still uses shared snapshots and covers all candidates.

- [ ] **Step 4: Refactor per-record observation and add targeted entry points**

Extract existing single-instance and single-turn logic without changing transitions. Targeted paths call `paneHost.inspectPane(paneId)` and then the same observation helper. Full paths retain project/shared-snapshot optimization. Add coalescing so an in-flight targeted request records another requested Pane instead of dropping it.

- [ ] **Step 5: Run focused verification**

Run: `npx vitest run tests/sqlite-store.test.ts tests/instance-runtime-reconciler.test.ts tests/instance-turn-supervisor.test.ts`

Expected: all store, instance runtime, and instance turn tests pass.

- [ ] **Step 6: Commit only Task 3 hunks**

Use `git add -p` for `src/domain/ports.ts`, `src/store/sqlite-store.ts`, and `tests/sqlite-store.test.ts` because they already contain unrelated user changes. Then stage the focused reconciler files and tests. Confirm the staged diff contains only Pane-targeted instance work before committing:

```bash
git diff --cached --check
git diff --cached --stat
git commit -m "perf: target Herdr instance reconciliation by pane"
```

### Task 4: Pane-targeted binding and external-turn observation

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `tests/herdr-runtime-reconciler.test.ts`
- Modify: `tests/external-turn-observer.test.ts`

**Interfaces:**
- Produces: `HerdrRuntimeReconciler.requestPaneReconciliation(paneIds)` or a unified scoped request with equivalent semantics.
- Produces: `ExternalTurnObserver.observeByPane(paneIds)`.
- Consumes existing `RuntimeReconciliationStore.findBindingByPane`.

- [ ] **Step 1: Write failing Pane-targeted tests**

For binding reconciliation, create two active bindings in one workspace and assert targeting one Pane performs an authoritative read and publishes transitions only for that binding. Include absent and terminal-identity-changed cases to prove the targeted path reuses existing orphan/degradation behavior.

For external turns, create bindings on two Pane IDs and assert `observeByPane(["w1:p1"])` opens/drains only the matching binding while `scanActiveBindings()` still covers both.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/external-turn-observer.test.ts`

Expected: FAIL because Pane-targeted entry points do not exist.

- [ ] **Step 3: Add targeted entry points using existing convergence helpers**

Refactor `HerdrRuntimeReconciler` so workspace and Pane paths share one per-Pane convergence function. A targeted request must reload `findBindingByPane`, call `observeRuntime`, and recheck binding generation and Pane identity before mutation. It must not perform discovery for unrelated Panes.

Implement `ExternalTurnObserver.observeByPane` as Pane-to-active-binding lookup followed by existing `observe(binding)`. Keep `start()` and `scanActiveBindings()` unchanged. Preserve the current bridge-turn busy check and explicit handoff behavior.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/external-turn-observer.test.ts tests/concurrency-controls.integration.test.ts tests/prompt-run-safety-scan.test.ts`

Expected: targeted behavior passes and existing handoff/no-replay tests remain green.

- [ ] **Step 5: Commit only Task 4 hunks**

Both source files already overlap active user work. Use `git add -p`, inspect every staged hunk, and commit only the event-routing additions and necessary refactor:

```bash
git diff --cached --check
git diff --cached --stat
git commit -m "perf: reconcile bindings from pane events"
```

### Task 5: Pane-targeted retired cleanup

**Files:**
- Modify: `src/coordinator/retired-pane-cleanup-workflow.ts`
- Modify: `tests/retired-pane-cleanup-workflow.test.ts`

**Interfaces:**
- Produces: `RetiredPaneCleanupWorkflow.requestPanes(paneIds: readonly string[]): Promise<void>`.
- Preserves: `recover()`, `requestScan()`, and the periodic timer.

- [ ] **Step 1: Write failing targeted cleanup tests**

Create cleanup operations for two Pane IDs. Assert `requestPanes(["w1:old"])` processes only that operation. Cover `waiting_busy -> succeeded`, absent Pane recovery, and an unrelated operation remaining unchanged.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run tests/retired-pane-cleanup-workflow.test.ts`

Expected: FAIL because `requestPanes` does not exist.

- [ ] **Step 3: Implement scoped cleanup draining**

Filter the durable operation list by the supplied Pane ID set, then invoke the unchanged `process(operation)` safety checks. Merge concurrent requested Pane IDs while a scan is active; a full scan request must dominate targeted requests. Do not close a Pane based on event-reported state.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/retired-pane-cleanup-workflow.test.ts`

Expected: all cleanup tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/coordinator/retired-pane-cleanup-workflow.ts tests/retired-pane-cleanup-workflow.test.ts
git diff --cached --check
git commit -m "perf: retry retired pane cleanup from events"
```

### Task 6: Composition wiring, documentation, and end-to-end verification

**Files:**
- Modify: `src/main.ts`
- Modify: `docs/architecture.md`
- Test: `tests/herdr-event-router.test.ts`
- Test: any composition-level test added only if existing seams cannot verify wiring

**Interfaces:**
- Consumes all targeted coordinator interfaces from Tasks 3-5.
- Replaces the inline socket callback with `HerdrEventRouter.handle`.
- Preserves all existing startup ordering, timers, shutdown ordering, and health status wiring.

- [ ] **Step 1: Add a wiring-level failing test or extend router integration coverage**

Prove one normalized Pane Agent-status hint does not call full binding or instance reconciliation, while a `socket-recovered` hint does. Also prove topology events invalidate only named workspace caches and request subscription refresh through the subscriber's existing behavior.

- [ ] **Step 2: Wire the router in `main.ts`**

Construct the router after its dependencies exist and pass `router.handle` to the subscriber through a closure that is safe during composition. Remove the current callback that ignores `paneIds`. Keep:

```ts
externalTurns.start();
instanceRuntime.start(config.reconcileIntervalMs);
instanceTurns.start(config.reconcileIntervalMs);
herdrSocketSubscriber?.startEvents();
```

Do not alter attached transcript polling constants or service readiness.

- [ ] **Step 3: Update current architecture documentation**

Document acknowledged subscription health, normalized scopes, Pane-targeted routing, and full periodic fallback in `docs/architecture.md`. Remove any statement implying TCP connect alone establishes event health. Keep the existing authority table intact.

- [ ] **Step 4: Run focused event and reconciliation tests**

Run:

```bash
npx vitest run tests/herdr-socket-subscriber.test.ts tests/herdr-event-router.test.ts tests/herdr-runtime-reconciler.test.ts tests/instance-runtime-reconciler.test.ts tests/instance-turn-supervisor.test.ts tests/external-turn-observer.test.ts tests/retired-pane-cleanup-workflow.test.ts tests/concurrency-controls.integration.test.ts tests/prompt-run-safety-scan.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Run repository verification**

Run, in order:

```bash
npm run typecheck
npm run build
npm test
```

Expected: TypeScript emits no errors, build identity generation succeeds, and the complete Vitest suite passes. Do not claim completion if any command fails; diagnose and rerun after the last edit.

- [ ] **Step 6: Review invariants and staged scope**

Confirm from the final diff and tests that:

- no event payload directly updates workflow state;
- no periodic timer was removed;
- no prompt replay path was added;
- attached transcript polling remains 250 ms;
- subscriber health requires ACK;
- a Pane event selects Pane-targeted work;
- malformed, unknown, and reconnect paths select full convergence.

- [ ] **Step 7: Commit only the final wiring and docs hunks**

`src/main.ts` and `docs/architecture.md` already contain user changes. Use `git add -p`, inspect the staged patch, and commit only this task's wiring/documentation:

```bash
git diff --cached --check
git diff --cached --stat
git commit -m "feat: route Herdr events to targeted reconciliation"
```

- [ ] **Step 8: Do not install or restart automatically**

Report verification and commits first. Run `./install.sh` and `npm run swarm:restart` only if the user separately requests deployment; inspect durable active-turn state before restarting as required by the service safety boundary.
