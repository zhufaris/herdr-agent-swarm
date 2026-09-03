# Herdr Event Router Design

## Goal

Use Herdr native events to wake the smallest authoritative reconciliation path
that can handle a runtime change, without making the socket event stream a state
source or weakening periodic recovery.

The change reduces broad workspace and instance scans after single-Pane events,
improves completion latency for observable turns and external turns, and makes
subscription health accurately represent an acknowledged Herdr subscription.

## Non-goals

- Do not remove startup or periodic reconciliation.
- Do not update SQLite workflow state directly from a Herdr event payload.
- Do not change prompt FIFO, steering eligibility, dispatch fencing, or the
  uncertain-dispatch/no-replay rule.
- Do not replace attached Answer transcript polling using Agent status events.
- Do not make socket event health a service-readiness requirement.
- Do not add a durable event log for Herdr socket events.

## Authority and safety boundary

Herdr remains authoritative for Pane identity, terminal identity, foreground
process, Agent identity, and Agent lifecycle state. SQLite remains authoritative
for bindings, instances, prompt and turn lifecycle, cleanup intent, and delivery
intent. Socket events are bounded, best-effort wake-up hints only.

An event may select which Pane, workspace, binding, instance, or turn should be
observed. It must not supply the state used to mutate SQLite. Every targeted
handler performs a fresh read through the existing Herdr adapter and applies the
same identity and generation fences as periodic reconciliation. Duplicate,
reordered, malformed, and lost events are safe because reconciliation is
idempotent and periodic scans remain active.

## Normalized event model

The subscriber converts protocol spellings into a small internal vocabulary. It
accepts the dotted and underscore spellings currently observed in Herdr 0.7.5,
but downstream code never branches on raw strings.

```ts
type HerdrEventKind =
  | "agent-status"
  | "pane-created"
  | "pane-updated"
  | "pane-closed"
  | "pane-moved"
  | "pane-exited"
  | "agent-detected"
  | "socket-recovered"
  | "invalid"
  | "unknown";

type HerdrEventScope = "panes" | "workspaces" | "all";

interface HerdrRuntimeHint {
  kind: HerdrEventKind;
  scope: HerdrEventScope;
  workspaceIds: string[];
  paneIds: string[];
}
```

Scope is explicit rather than inferred from empty identifier arrays:

- A recognized Agent status event with Pane IDs has `scope: "panes"`.
- A topology event with workspace identity has `scope: "workspaces"`.
- Reconnect recovery, malformed input, an unknown event, or a recognized event
  without enough identity has `scope: "all"`.

Hint coalescing unions identifiers without discarding Pane scope merely because
another hint lacks workspace IDs. Combining different scopes selects the wider
scope. Combining different event kinds may use `unknown` as the reason while
retaining the correctly widened scope and identifiers. Identifier extraction
keeps the current depth, count, and string-length bounds.

## Subscription lifecycle

The persistent socket connection has four observable states: disconnected,
connecting, subscribing, and subscribed. `eventsConnected` is true only in the
subscribed state.

After TCP connection, the subscriber sends `events.subscribe` with a unique
request ID and starts a bounded acknowledgement timer. It does not log a
successful subscription or emit recovery work yet. A matching successful
response transitions to subscribed, resets reconnect backoff, logs connection or
recovery, and emits one `socket-recovered` full-scope hint. A matching error,
invalid acknowledgement, acknowledgement timeout, transport failure, or socket
close leaves `eventsConnected` false, closes the connection, resolves Pane
waiters as unchanged, and enters the existing bounded reconnect loop.

Subscription-set refresh continues to reconnect after Pane topology changes.
The refreshed stream follows the same acknowledgement process. Ordinary
short-lived socket RPC requests retain their existing independent request IDs and
connections.

## Event router

`HerdrEventRouter` is a non-durable orchestration component between the socket
subscriber and existing coordinators. It owns event-to-wake-up policy,
coalescing concurrent requests where necessary. It does not own domain state or
perform direct SQLite transitions. `main.ts` only wires its dependencies and
passes normalized hints to it.

### Pane-scoped Agent status event

For every affected Pane, the router concurrently requests these independently
safe operations:

1. Reconcile the binding attached to that Pane using a fresh Pane observation.
2. Reconcile the agent instance whose runtime reference names that Pane.
3. Observe any persisted instance turn associated with that Pane.
4. Ask the external-turn observer to drain the binding associated with that Pane.
5. Retry a retired-Pane cleanup operation for that Pane when it is waiting for a
   busy Agent to settle.

Each target is looked up from SQLite by Pane ID. Missing targets are normal and
produce no state change. Failures are isolated and logged so one target does not
prevent the others from converging.

### Workspace-scoped topology event

For a Pane create, update, move, close, exit, or Agent-detected event, the router
invalidates affected workspace snapshots and requests workspace-scoped binding
and instance reconciliation. A close or move may need both the old and new
workspace when both identities are present. The subscriber refreshes its
per-Pane Agent-status subscription set after topology changes.

When a topology event also includes a Pane ID, Pane-scoped turn observation and
cleanup may run in addition to workspace reconciliation. Absence and moved-Pane
decisions still require authoritative reads; the event alone never detaches a
binding or instance.

### Full-scope recovery event

Reconnect recovery, malformed frames, unknown event semantics, or insufficient
identity trigger the existing full binding and instance reconciliation paths. A
full-scope hint may also request the existing turn, external-turn, and cleanup
safety scans, but duplicate requests must coalesce with work already running.

## Targeted coordinator interfaces

Targeted methods complement rather than replace existing full-scan methods:

```ts
HerdrRuntimeReconciler.requestPaneReconciliation(paneIds: readonly string[]): Promise<void>
InstanceRuntimeReconciler.requestReconciliation(scope?: {
  paneIds?: readonly string[];
  workspaceIds?: readonly string[];
}): Promise<void>
InstanceTurnSupervisor.requestObservationByPane(paneIds: readonly string[]): Promise<void>
ExternalTurnObserver.observeByPane(paneIds: readonly string[]): Promise<void>
RetiredPaneCleanupWorkflow.requestPanes(paneIds: readonly string[]): Promise<void>
```

The exact store queries should be Pane-indexed and return only current candidates.
Every method reloads the record before applying a transition and checks existing
generation, identity, lifecycle, and ownership constraints. Existing methods such
as `reconcile()`, `scanActiveBindings()`, and `requestScan()` remain the safety
paths used at startup and on timers.

Pane-scoped binding reconciliation should reuse the same per-Pane convergence
logic as workspace reconciliation instead of creating a second transition path.
Likewise, instance and turn reconcilers should share their existing single-record
observation functions between targeted and full scans.

## Transcript behavior

The attached transcript observer continues its 250 ms polling loop. Agent status
can remain `working` while Answer deltas are produced, so
`pane.agent_status_changed` cannot replace transcript polling.

The detached observer keeps its existing event-assisted bounded wait and timeout
fallback. External-turn observation gains Pane-event wake-ups, but retains its
periodic active-binding scan because an external turn can produce multiple deltas
without changing Agent state. A future `pane.output_matched` optimization requires
separate protocol validation and a non-content-bearing match; it is outside this
change.

## Cache behavior

Topology events invalidate affected workspace snapshots. Agent-status events do
not blindly patch cached Pane objects from their payload. Targeted observation
may refresh a single cached Pane through `observeRuntime`, while full and
workspace snapshots retain their generation fences.

No pane-level invalidation API is required initially: targeted reads bypass the
workspace list cache through `observeRuntime`, and topology changes invalidate the
owning workspace. This avoids inventing partial-snapshot completeness semantics.

## Periodic recovery

The configured 30-second reconciliation interval remains enabled for bindings,
instances, observable turns, and cleanup. The external-turn safety scan remains
enabled; its interval may only be increased after event-path metrics demonstrate
reliable wake-ups. Startup recovery and a successfully re-established subscription
always request full convergence.

No event-dependent wait is unbounded. Pane waiters, subscription acknowledgement,
Agent startup, detached-turn observation, and shutdown all retain timeout or abort
paths.

## Observability

Socket status distinguishes transport connection from acknowledged subscription.
Structured logs include normalized kind, scope, workspace IDs, Pane IDs, routing
outcome, subscription acknowledgement latency, and fallback reason without
including terminal or prompt content.

Router diagnostics expose counts for pane-, workspace-, and full-scope hints,
coalesced hints, targeted handler failures, and fallback requests. Existing
reconciliation diagnostics remain available so operators can compare targeted
wake-ups with periodic convergence.

## Testing

Focused tests cover:

- subscription remains unready until a matching acknowledgement arrives;
- error, timeout, close-before-ack, and malformed acknowledgement reconnect;
- dotted and underscore names normalize identically;
- hint merging preserves Pane IDs and widens scope deterministically;
- a Pane Agent-status event invokes only Pane-targeted handlers;
- topology events invalidate and reconcile only affected workspaces when scoped;
- unknown or identity-free events request full convergence;
- targeted instance and turn paths preserve generation and identity fences;
- a waiting-busy cleanup retries only for its Pane;
- lost events still converge through periodic reconciliation;
- attached transcript streaming retains its polling behavior.

Before handoff, run affected Vitest files, `npm run typecheck`, `npm run build`,
and the full `npm test` suite because the change crosses runtime, coordinator, and
recovery boundaries.

## Rollout order

1. Add subscription acknowledgement correctness and normalized hint tests.
2. Introduce the event router with fake targeted consumers.
3. Add Pane-targeted instance runtime and instance-turn observation.
4. Add Pane-targeted binding, external-turn, and retired-cleanup wake-ups.
5. Wire the router in `main.ts` and retain all existing timers.
6. Validate diagnostics and full fallback behavior before considering any polling
   interval change.
