# Runtime Event Bus and Steer Dispatch Design

## Goal

Replace the separately implemented process-local event mechanisms with one
composition-owned deep module while preserving their distinct reliability
contracts. Move active-turn steer execution out of request handlers and behind
a durable, owner-serialized dispatcher. SQLite and fresh Herdr observation
remain authoritative.

This is the first Clean Architecture boundary in the broader module-boundary
review. Later boundaries are listed for follow-up, but this change implements
only runtime events and turn-control dispatch.

## Invariants

- A process-local event is never a persistence authority.
- Inbound work, Prompt/Worker turns, turn-control operations, card projections,
  and outbound delivery intent are committed to SQLite before a wake-up.
- Event envelopes never contain prompt, steer, terminal, or answer content.
- A lost, duplicate, reordered, or coalesced work hint is safe because consumers
  reload and claim durable state.
- Lifecycle fan-out failures are isolated; durable projection recovery remains
  responsible for convergence.
- A steer is never replayed after native dispatch may have started. A restart
  changes `dispatching` operations to `uncertain`; only `accepted` operations
  are eligible for dispatch.
- Active turn control remains fenced by owner generation, pane identity, native
  Agent session, logical turn, and runtime turn.
- Unsupported active steering is rejected explicitly and is never silently
  converted into an ordinary Prompt. Idle steering remains a durable priority
  Prompt or Worker Turn.

## Chosen architecture

### RuntimeEventBus

Introduce one `RuntimeEventBus` module with typed channels and a shared envelope:

```ts
interface RuntimeEventEnvelope<Channel, Key, Payload> {
  eventId: string;
  channel: Channel;
  key: Key;
  occurredAt: string;
  payload: Payload;
}
```

The module owns registration, duplicate-name protection, failure isolation,
coalescing, startup buffering, sealing, shutdown, and diagnostics. It does not
expose `publish(any)`. Composition and workflows receive narrow channel ports.

| Channel | Contract | Key/coalescing | Authority |
| --- | --- | --- | --- |
| `lifecycle` | Awaited fan-out of typed domain outcomes | Never coalesced | Transactional aggregate/projection state |
| `inbound` | Notification that a durable inbound row is ready | Message event ID | SQLite inbound table |
| `work` | Best-effort request to drain durable work | Work kind plus owner ID | SQLite queues/outbox/invalidations |
| `herdr` | Bounded request for authoritative reconciliation | Snapshot scope | Fresh Herdr snapshot plus SQLite |

Existing interfaces such as `LifecycleEventPublisher`, `PromptWorkScheduler`,
`InboundWorkNotifier`, and `OutboundWorkNotifier` remain narrow compatibility
ports during migration. Their adapters delegate to `RuntimeEventBus`; they no
longer own independent listener collections or scheduling logic. Call sites
therefore retain capability-focused dependencies while infrastructure becomes
uniform.

The work channel uses a closed discriminated union:

- `primary-ready { bindingId }`
- `worker-ready { instanceId }`
- `outbox-ready`
- `turn-control-ready { ownerKind, ownerId }`
- `card-context-ready`

Keys coalesce repeated readiness for the same durable drain scope. Payloads are
identifiers only. Consumers must query SQLite and drain until no eligible work
remains.

### TurnControlDispatcher

`TurnControlWorkflow` retains command validation and acceptance. For an active
turn it atomically inserts an `accepted` `turn_control_operation`, reserves any
result-card intent, and publishes `turn-control-ready`. It no longer performs a
Herdr effect in the inbound request stack.

`TurnControlDispatcher` is a separate application module with a small interface:

```ts
wake(owner: TurnControlOwner): void
recover(): Promise<RecoverySummary>
stop(): Promise<void>
```

For each owner it serially reloads accepted operations, revalidates the complete
exact-turn fence, atomically claims one operation, invokes the allowed Herdr
control effect, persists the terminal result, and wakes the durable outbox.
Different owners may progress independently. Repeated work hints are harmless.

To preserve the no-replay boundary, startup recovery first marks every
`dispatching` operation `uncertain`, then publishes readiness for owners with
remaining `accepted` operations. The dispatcher never claims `uncertain` work.

Idle steer remains synchronous durable conversion because it performs no native
effect: the workflow inserts the priority Prompt or Worker Turn and emits the
corresponding `primary-ready` or `worker-ready` work hint. The new dispatcher is
only for accepted active-turn control operations.

## Diagnostics and shutdown

The status snapshot reports per channel:

- published envelope count;
- delivered listener count;
- coalesced hint count;
- subscriber failure count and last failure metadata;
- pending buffered/coalesced key count.

Diagnostics contain event kind, key, IDs, and subscriber name, never payload
content. During shutdown, the bus stops accepting new best-effort hints after
producers are stopped, then waits for already-started awaited fan-out. The
turn-control dispatcher follows the existing deadline behavior: unclaimed work
stays `accepted`; claimed work becomes `uncertain` if completion cannot be
confirmed.

## Migration and compatibility

1. Introduce the generic typed channel engine and test its delivery, coalescing,
   startup buffering, duplicate subscriber names, failure isolation, and
   diagnostics.
2. Make `RuntimeEventIntegration` a facade over one `RuntimeEventBus`; preserve
   existing narrow properties while migrating composition to the typed work
   channel.
3. Move turn-control effect execution into `TurnControlDispatcher` and wire it
   to `turn-control-ready`. Keep durable operation and result-card schemas.
4. Remove the old independent notifier implementations after all consumers use
   bus-backed adapters.
5. Update architecture documentation and status tests.

No SQLite schema migration is required. Existing accepted/dispatching recovery
semantics and idempotency keys remain valid.

## Verification

Tests must prove:

1. Each channel preserves its declared delivery and coalescing semantics.
2. Channel names and payloads are compile-time closed; there is no generic public
   publisher on the composition facade.
3. Subscriber failures are isolated and redact payload content.
4. Pre-seal work hints are retained once per durable work key.
5. Duplicate steer requests create one durable operation and one native effect.
6. Active-turn steer returns after durable acceptance and is dispatched outside
   the request call stack.
7. Different owners are independent while operations for one owner are ordered.
8. Restart resumes `accepted` operations and never replays `dispatching` or
   `uncertain` operations.
9. Idle steer remains a priority Prompt/Worker Turn and preserves FIFO priority.
10. Exact-turn identity changes reject the operation before the Herdr effect.
11. Focused runtime-event, turn-control, ingress, recovery, status, architecture,
    typecheck, build, and full-suite checks pass.

## Follow-up boundary inventory

After EventBus completion, review these boundaries independently: inbound
admission/routing, Primary execution and observation, Worker execution and
observation, card projection/convergence, durable delivery, Herdr runtime
reconciliation, instance lifecycle/workspaces, command/control, and operations/
health. Each follow-up must keep a narrow domain port, one durable authority, and
explicit recovery semantics; this document does not authorize changing them.
