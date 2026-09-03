# Composition factory design

## Goal

Reduce `src/main.ts` to process bootstrap and lifecycle ownership without
changing the service's runtime behavior or recovery safety properties.

## Boundary

Introduce a composition factory that constructs and returns the configured
runtime object graph: adapters, caches, stores, event bus, dispatchers,
workflows, reconcilers, the inbound coordinator, and the shutdown-facing
dependencies. The factory may wire callbacks between these objects, but it
must not start workers, acquire leases, open sockets, create the health server,
or register process signal handlers.

`main.ts` remains the only owner of side effects and preserves its existing
ordering:

1. Load and validate configuration; create the base store and lease.
2. Build the dependency graph.
3. Acquire the lease, activate the SQLite write fence, and start heartbeat.
4. Run recovery/integrity preparation and create the health server.
5. Construct shutdown handling, then start publishers and workers.
6. Register signal handlers and start the coordinator/runtime loops.
7. On failure, keep the existing cleanup path and ownership semantics.

## Interfaces

The factory returns a typed `ComposedBridgeRuntime` object. It exposes only
objects used by `main.ts` for lifecycle ownership, health wiring, or shutdown:
the coordinator, publisher/projectors, lease/store, runtime reconcilers,
integrity auditor, socket subscriber, retention workers, and supporting
gateways. Internal construction order remains encapsulated.

## Non-goals

- Do not change SQLite schema, transaction boundaries, or port contracts.
- Do not alter FIFO, steering, no-replay, outbox, CardKit ordering, or lease
  fencing behavior.
- Do not turn the factory into a second lifecycle manager.
- Do not split the existing startup/shutdown orchestration into asynchronous
  phases with different error handling.

## Verification

Add architecture assertions that `main.ts` delegates concrete runtime graph
construction to the factory while retaining lease/fence/integrity/shutdown
ordering. Run focused architecture tests, TypeScript checking, build, and the
appropriate integration regressions.
