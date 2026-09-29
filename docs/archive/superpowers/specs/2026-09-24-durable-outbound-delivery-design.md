# Durable Outbound Delivery Design

## Goal

Deepen durable outbound delivery without changing lane ordering, fairness,
concurrency, retries, dead letters, checkpoint semantics, Card convergence, or
Gateway behavior. SQLite remains the sole delivery authority.

## Current problem

`OutboundDeliveryExecutor` already isolates one claimed external effect, but the
301-line `GatewayOutboxDispatcher` owns both lifecycle scheduling and the full
lane-drain algorithm. Both modules depend on the complete `OutboxStore`, hiding
which durable capabilities each actually needs.

## Considered approaches

### A. Extract a lane-drain engine and narrow store ports (chosen)

Keep `GatewayOutboxDispatcher` as the lifecycle facade for notifier subscription,
safety scans, retry timers, scan coalescing, diagnostics, and shutdown. Extract
`OutboundLaneDrain.drain(force, context)` for fair lane selection, bounded
concurrency, per-lane exclusion, duplicate-attempt prevention, fatal checkpoint
settlement, and timing aggregation. Keep `OutboundDeliveryExecutor` as the
single-reply effect module.

### B. Narrow store ports only

This improves types but leaves two independent state machines in one dispatcher.
It does not improve locality enough.

### C. Merge drain and delivery into one module

This would couple queue scheduling to Gateway-specific preparation, execution,
failure classification, and checkpoints, reducing testability and depth.

## Authority and invariants

- SQLite owns intents, lane heads, claims, attempt fences, checkpoints, retries,
  cooldown, dead letters, and recovery eligibility.
- A lane has at most one active delivery. Independent lanes may run concurrently.
- Live/history dispatch retains the existing 3:1 preference and four-delivery
  concurrency cap. One scan attempts at most 100 distinct replies.
- External success without a confirmed durable checkpoint is fatal and uncertain;
  it is never automatically replayed in the same scan.
- A failed lane is blocked for the remainder of that scan while sibling lanes
  settle. Wake hints and timers are never delivery authority.

## Modules

`GatewayOutboxDispatcher` retains `start`, `stop`, `requestScan`, `snapshot`, and
checkpoint subscription. It owns scan lifecycle and delegates one scan.

`OutboundLaneDrain` exposes one method:

```ts
drain(force: boolean, context: OutboundLaneDrainContext): Promise<OutboundLaneDrainResult>
```

The context supplies stopping state, active-work tracking, and scan revision wake
coordination without exposing the algorithm to the facade. The result contains
outcome, delivery timestamps, and aggregate timing for diagnostics.

`OutboundDeliveryExecutor` continues to expose `deliver(reply, dueAt)` and owns
Gateway plan preparation, durable claim, external execution, checkpoint, failure
classification, quarantine, and post-delivery notifications.

Add `OutboundScanStore` and `OutboundDeliveryStore` as consumer-shaped `Pick`s
over the existing `OutboxStore`; no SQLite implementation or schema changes.

## Recovery and shutdown

The facade recovers eligible transient dead letters before each scan and schedules
the next retry from durable lane-head/cooldown state. Stop prevents new claims but
waits for all active deliveries and the current drain. The lane engine drains
siblings before surfacing a checkpoint uncertainty.

## Verification

Use existing outbox integration coverage for fairness, concurrent lanes, late
work, stop behavior, checkpoint uncertainty, cooldown, retry, dead-letter, and
startup discovery. Add an interface-level lane-drain tracer test and architecture
guards for the three-module split and narrow ports. Then run the full repository
suite and standard build/documentation gates.

## Non-goals

- No delivery policy, retry constant, SQL, Gateway contract, Card behavior, or
  user-visible change.
- No generic queue framework and no in-memory durable queue.
- No Herdr reconciliation refactor in this pass.
