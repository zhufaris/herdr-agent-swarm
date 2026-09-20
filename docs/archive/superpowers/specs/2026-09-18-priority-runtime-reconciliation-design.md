# Priority Runtime Reconciliation

**Date:** 2026-09-18

## Problem

Herdr socket events already provide pane- and workspace-scoped wake-up hints, but
the two runtime reconcilers implement different scheduling state machines. The
Primary binding reconciler has a workspace scheduler plus a separate pane path
that waits for the workspace scheduler to become idle. The Worker instance
reconciler has its own scope merge and single-flight loop. A pane event arriving
during a long full or workspace pass is therefore serialized safely, but the
Primary path cannot express that the pane follow-up is the most time-sensitive
pending work. The duplicated scheduling logic also makes stop, coalescing,
metrics, and future priority behavior harder to keep consistent.

Periodic scans remain necessary for convergence after lost events. They must
not determine normal user-visible latency when a precise Herdr event is
available.

## Goals and success criteria

- Preserve one reconciliation writer at a time within each domain.
- Give pending pane work priority over workspace work, and workspace work
  priority over a full scan.
- When a Herdr pane event arrives during another pass, start the coalesced pane
  follow-up immediately after the active pass, before lower-priority pending
  work.
- Keep Primary binding and Worker instance execution isolated: they share the
  scheduling implementation but never share an execution queue or failure
  boundary.
- In the absence of an external failure, complete the targeted durable binding
  or instance convergence and reserve any resulting card outbox intent within
  one second of accepting the Herdr event. The one-second budget excludes an
  already-running reconciliation pass and external Lark delivery time; both are
  reported separately rather than hidden inside this local target. When another
  pass is already active, the measurable requirement is that the pane pass is
  selected immediately after it, ahead of every lower-priority pending scope.
- Remove the duplicated scope merge and single-flight machinery from the two
  reconcilers without weakening their domain-specific convergence rules.
- Retain periodic full scans as the durable convergence fallback.

## Non-goals

- Do not introduce a payload-bearing in-memory queue. SQLite remains the only
  durable authority; the runner holds only bounded, coalescible identifiers and
  wake-up intent.
- Do not run two reconciliation passes concurrently within the same domain.
- Do not combine Primary and Worker reconciliation into one global queue.
- Do not change prompt FIFO, exact-turn identity, no-replay, lease, outbox, card
  ordering, or lifecycle transition semantics.
- Do not remove periodic safety scans or promise a one-second Lark-visible SLA.
- Do not lower global debounce or polling intervals merely to satisfy the target.

## Design

### Typed priority scope

Add a small runtime utility that owns only scheduling mechanics. Its public scope
is a discriminated union:

```ts
type PriorityReconciliationScope =
  | { kind: "panes"; ids: readonly string[] }
  | { kind: "workspaces"; ids: readonly string[] }
  | { kind: "all" };
```

The runner receives an async executor and optional hooks for error reporting and
diagnostics. It knows nothing about bindings, instances, SQLite, Herdr, cards,
or projects. Each reconciler owns one runner instance and translates the scope
into its existing domain-specific pass.

### Priority and merge rules

The runner has one active pass and three bounded pending representations:

- pane IDs are de-duplicated in a `Set`;
- workspace IDs are de-duplicated in a `Set`;
- a full-scan flag represents all work.

After the active pass settles, the runner always takes pending work in this
order: panes, workspaces, all. Requests of the same kind coalesce. A broader
pending request does not erase a more urgent narrower request: a pane hint must
still run first even when a full scan is pending. Once a successful pass covers
lower-priority pending scope, the runner removes only work proven covered:

- a successful full pass covers every pending workspace, but not a pane request
  accepted after the full pass began;
- a successful workspace pass covers matching pending workspace IDs, but not a
  later pane request for that workspace;
- a pane pass covers only its captured pane IDs.

Requests accepted while a pass is active are tagged by the runner's monotonic
request revision. This prevents an active broad pass from accidentally absorbing
a newer event. There is no unbounded item queue: repeated identifiers collapse,
and the `all` scope is one bit.

### Request completion semantics

Every request returns a promise that settles only after the accepted request is
either executed or proven covered by a successful pass that started after its
revision. A caller awaiting a pane hint therefore cannot return merely because
an older full scan happened to be active. Errors reject only request waiters
covered by the failed pass; later pending work remains scheduled and can still
run.

### Primary binding integration

`HerdrRuntimeReconciler` replaces `ReconciliationScheduler` and the separate
`waitForIdle()` pane loop with one priority runner:

```text
pane scope      -> observeRuntime for owned active/orphaned panes -> BindingRuntimeConverger
workspace scope -> existing workspace snapshot reconciliation
all scope       -> existing full snapshot reconciliation and prune
```

The pane executor retains the lifecycle eligibility rule in
`BindingRuntimeConverger`; historical pane ownership is still visible and
terminal bindings remain immutable. Workspace cooldown remains a policy of the
Primary adapter around successful workspace/full execution. It must never
suppress pane scope.

### Worker instance integration

`InstanceRuntimeReconciler` delegates scope ordering, merging, single-flight,
stop, and base metrics to its own priority runner. Its executor preserves the
existing instance identity fences, pending-runtime attachment, terminalization,
observation update, card-context wake-up, and queued-turn wake-up behavior.

Targeted pane inspection uses the narrowest authoritative PaneHost method
available. A bulk snapshot remains an allowed optimization only when the adapter
cannot inspect the requested panes safely or when a workspace/full pass already
owns that snapshot. This design does not add a second cache.

### Herdr event routing and cards

`HerdrEventRouter` remains a reliability-specific fan-out boundary. It
invalidates the relevant snapshot cache and submits independent work to the
Primary and Worker runners. Primary transcript observation remains ordered after
Primary binding convergence for the same hint. Worker turn observation and
retired-pane cleanup remain independent consumers isolated with
`Promise.allSettled`.

Durable reducers continue to reserve card intent before delivery. Existing
outbound wake-ups and `CardUpdateScheduler` priorities carry a changed durable
view into the outbox. No direct Lark call is introduced into reconciliation, and
the existing card debounce is not globally reduced.

## Failure, shutdown, and recovery

- An executor failure is recorded in existing reconciliation diagnostics and
  rejects only the affected request generation. The runner immediately considers
  newer pending work instead of wedging the queue.
- Primary and Worker failures remain isolated because they use distinct runner
  instances and are still joined by the router with `Promise.allSettled`.
- `stop()` rejects or resolves no work speculatively: it stops accepting new
  requests, discards pending wake-up hints, clears the periodic timer, and waits
  for the active pass. It never cancels an in-progress SQLite transition.
- A lost hint is harmless. The periodic full pass, fresh Herdr snapshot, SQLite
  state, and existing exact-turn observers remain the convergence authorities.
- Process restart loses only coalesced wake-up identifiers. Startup recovery
  reconstructs work from SQLite and Herdr; no prompt or delivery payload is lost
  or replayed by the runner.

## Observability

Extend reconciliation diagnostics with scheduling evidence that is bounded and
safe to expose through `/status`:

- pending pane and workspace counts plus whether a full scan is pending;
- active scope kind;
- priority promotion count (a pane/workspace request selected ahead of lower
  priority pending work);
- coalesced request count, preserving the existing field;
- last accepted-to-start delay and maximum accepted-to-start delay by scope kind.

The one-second target is asserted against accepted-to-completed local work in a
deterministic idle-runner integration test. The queued-behind-active case is
asserted separately by execution order and diagnosed in production from
accepted-to-start plus the existing pass duration. IDs and payload text are not
added to metrics.

## Verification

Focused tests must prove:

1. During an active full pass, pane, workspace, and another full request are
   accepted; the next executions are pane, workspace, then full.
2. Duplicate pane and workspace IDs coalesce without losing identifiers.
3. A broad pass cannot absorb a narrower request accepted after that pass began.
4. Primary pane reconciliation no longer waits through lower-priority pending
   workspace/full work.
5. Worker instance reconciliation uses the same ordering while remaining an
   independent runner.
6. At most one executor is active per runner, including failure and stop paths.
7. A failed pass does not discard later pending work and updates diagnostics.
8. Stopping prevents queued work from starting and waits for the active pass.
9. A targeted Herdr event completes durable convergence and reserves resulting
   card outbox intent within one second under a controlled local integration
   fixture.
10. Periodic full reconciliation still recovers a deliberately dropped hint.
11. Archived/closed/failed/provisioning bindings remain ineligible, and exact
    prompt/turn no-replay tests remain green.

After focused tests, run `npm run typecheck`, `npm run architecture:check`,
`npm run docs:audit`, `npm run build`, `git diff --check`, and `npm test` in that
order. Build and tests must not run concurrently because installer tests consume
the atomically replaced `dist/` tree. Installation and restart remain separate
operator actions behind the active-work safety gate.

## Rejected alternatives

### Concurrent pane and full reconciliation

This minimizes queueing delay but allows two observations to race on the same
binding or instance. Correctness would require new fences and conflict handling
for no durable benefit.

### One global Primary and Worker runner

This removes more code but couples unrelated domains: a slow binding scan would
delay Worker state, and one failure would enlarge the blast radius. Sharing the
mechanism while keeping separate instances is the deeper boundary.

### Add priority only to `HerdrEventRouter`

The router does not own reconciliation single-flight state, so it cannot enforce
execution order without duplicating or bypassing the reconcilers' schedulers.
Priority belongs at the serialization seam.

### Lower polling and debounce intervals

This increases steady Herdr, SQLite, and Lark load while leaving duplicated
scheduling semantics intact. Events provide low latency; polling remains
the safety net.
