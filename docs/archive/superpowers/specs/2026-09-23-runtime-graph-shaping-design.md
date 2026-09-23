# Runtime Graph Shaping

Status: completed and archived.

## Goal

Reduce the amount of internal topology that crosses the `createBridgeRuntime()`
seam. Replace its broad flat result with a small set of responsibility-shaped
groups, including a ready-to-consume health diagnostics view, while preserving
the existing startup, shutdown, recovery, and health behavior.

## Current problem

`createBridgeRuntime()` currently exposes more than twenty individual runtime
objects. `createManagedBridgeRuntime()` immediately destructures those objects,
reassembles most of them into lifecycle dependencies, and separately rebuilds a
large health-server options object. This makes both composition layers know the
same topology and causes every new internal module to widen the top-level seam.

The worker diagnostics aggregator is also constructed in the top-level factory,
even though its state comes entirely from the worker runtime. This leaks worker
implementation knowledge into unrelated composition code.

## Chosen shape

`createBridgeRuntime()` returns one graph with three named groups:

- `lifecycle`: modules and ports whose start/stop/recovery ordering is owned by
  `ManagedBridgeRuntime`;
- `health`: already-shaped diagnostic providers consumed by `startHealthServer`;
- `operations`: the small set of runtime capabilities needed outside those two
  concerns, such as the Gateway transport used by health construction.

The exact fields remain structural TypeScript values rather than new classes.
The groups make ownership explicit without adding pass-through methods or a new
runtime container abstraction.

`createManagedBridgeRuntime()` consumes those groups directly. It may add host
configuration, lease, build identity, and store-backed health data because those
facts belong to managed process composition. It no longer knows how worker
diagnostics combine dispatch and observation state.

## Health view

The bridge graph exposes a `health` group containing the runtime-owned providers
needed by the health server: workspace cache, circuit breaker, startup recovery,
inbound and session-operation dispatchers, binding and instance reconciliation,
combined instance-worker diagnostics, integrity, lifecycle events, card
convergence, outbox dispatch, prompt worker, and optional Herdr socket status.

This is a data-shaped interface, not a `createHealthServerDependencies()` proxy.
It removes duplicated wiring knowledge without moving host concerns such as HTTP
configuration, project registry, build identity, Gateway adapter, SQLite health
store, or lease out of `createManagedBridgeRuntime()`.

The combined instance-worker diagnostic provider moves into
`createWorkerRuntime()`, beside the two sources it combines. Its output contract
remains identical: dispatch state and failures take precedence, while observer
counts and turn state come from instance turn supervision.

## Lifecycle group

The `lifecycle` group contains the exact capabilities required by
`ManagedBridgeRuntimeDependencies`: Primary tool and controller ingress,
integrity auditing, instance reconciliation and turns, cached Herdr snapshots,
instance work, outbound publisher and retention, projection modules, coordinator,
pane retention, external-turn observation, the event bus, and optional socket
subscriber.

The managed runtime retains all lifecycle policy. Grouping must not move start,
stop, registration, cleanup-stage, writer-kind, or lease decisions into
`createBridgeRuntime()`. The group only makes the already-existing dependency
surface explicit.

## Behavioral boundaries

This refactor does not:

- change startup or shutdown order, cleanup stages, writer classification, or
  ownership-retention behavior;
- change health response fields, readiness rules, or active-work detection;
- change event routing, prompt execution, reconciliation, delivery, or recovery;
- change SQLite schema, configuration, service lifecycle commands, or logging;
- introduce a generic dependency bag or expose the complete SQLite store bundle.

## Testing

Tests should characterize the public graph shape and the worker diagnostic
aggregation through their composition interfaces. Existing managed-runtime and
health tests remain the behavioral authority for lifecycle order and health JSON.
An architecture test should prevent `createManagedBridgeRuntime()` from
destructuring the bridge graph back into a broad flat list.

Before completion, run focused composition, managed-runtime, health, and
architecture tests, followed by typecheck, build, the full Vitest suite,
architecture check, documentation audit, public audit, and diff check. Review
the result independently against repository standards and this design.
