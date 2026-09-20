# Unified Event Integration Design

## Status

Approved as the final architecture-convergence slice.

## Objective

Give runtime composition one explicit event-integration module without pretending
that every signal has the same durability or replay contract. The module makes
event ownership, wiring, diagnostics, and terminology discoverable while SQLite
and fresh Herdr observation remain authoritative.

## Reliability classes

The integration exposes distinct typed channels rather than a generic event bus:

1. **Durable inbound records** are accepted and claimed through the existing
   SQLite inbound store. The in-process inbound notification is only a post-write
   acceleration hint; startup recovery scans the durable rows.
2. **Transactional lifecycle and outbound intent** remain SQLite aggregate
   transitions. Typed lifecycle publication drives deterministic projections,
   while rendered outbound intent is persisted in the same required transaction.
   The lifecycle fan-out is not an event store and cannot replay commands.
3. **Best-effort work wake-ups** cover inbound, outbound, Primary prompt, and
   Worker instance work. They may be coalesced, reordered, or lost. Consumers
   reload SQLite and atomically claim work; periodic/startup scans converge loss.
4. **Bounded Herdr socket hints** carry only normalized Pane/workspace scope. A
   hint invalidates caches and requests fresh Herdr reconciliation. Socket payload
   is never accepted as workflow truth.

## Module interface

`RuntimeEventIntegration` is internal to composition. It constructs the lifecycle
bus, inbound notifier, outbound notifier, prompt scheduler, typed startup wake-up
hub, and the Herdr hint connection. Callers receive the existing narrow publisher,
subscriber, notifier, and scheduler interfaces; they do not depend on the concrete
integration class.

The module offers explicit wiring operations for cyclic startup relationships:
register the Worker instance wake-up handler, connect the Herdr hint router, and
seal the integration. Pre-seal work hints retain the existing bounded coalescing
behavior. Missing registrations fail during composition. Herdr hints before the
router is connected fail as a configuration error rather than being interpreted.

`createBridgeRuntime` owns one integration instance and passes its narrow channels
to the existing composition graphs. `createOutboundRuntime` stops constructing a
private outbound notifier, so all process-local event wiring has one composition
owner. Domain and coordinator modules retain their current narrow ports.

## Invariants

- No unified `publish(any)` or shared replay guarantee is introduced.
- A wake-up never contains prompt text or replaces a durable claim.
- Lifecycle fan-out failure remains isolated and observable.
- Outbound intent is persisted before the outbound wake-up.
- Lark inbound acceptance is persisted before the inbound notification.
- Herdr socket hints only schedule observation; fresh snapshots determine state.
- Duplicate, missing, and reordered hints cannot duplicate TraeX submission.
- Exact-turn fencing, FIFO, no-replay recovery, outbox ordering, and nested SQLite
  transaction semantics remain unchanged.

## Diagnostics

The integration exposes a small snapshot containing the reliability-class labels
and lifecycle subscriber diagnostics. Existing notifier, scheduler, Herdr router,
and socket diagnostics remain at their owning runtime interfaces; the integration
does not invent counters that those modules cannot measure accurately.

## Testing

Focused tests verify one owned instance of each channel, pre-seal coalescing,
missing registration failure, Herdr connection fencing, subscriber failure
isolation, and preservation of durable-before-wake paths through existing inbound
and outbound tests. Architecture tests require `createBridgeRuntime` to construct
the integration rather than individual event implementations and require outbound
composition to receive its notifier.

Before handoff, run focused integration/event tests, strict unused checking, the
full Vitest suite, typecheck, build, documentation audit, architecture checks, and
`git diff --check`.

## Non-goals

- No Kafka, external broker, event sourcing, or durable wake-up log.
- No replacement of SQLite inbound/outbox tables.
- No replay of lifecycle events into workflow commands.
- No removal of startup or periodic reconciliation.
- No change to Lark, Herdr, CardKit, or health response contracts.
