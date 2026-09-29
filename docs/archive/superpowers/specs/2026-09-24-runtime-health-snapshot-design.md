# Runtime Health Snapshot Design

## Goal

Deepen runtime health observation without changing endpoint paths, response
shapes, readiness gates, degradation policy, caching, or lifecycle ownership.
Health remains observational and never becomes workflow authority.

## Current problem

Runtime startup and shutdown already have strong seams: `ManagedBridgeRuntime`
owns phase ordering, `RuntimeLifecycleLedger` records possibly started resources,
and `BridgeRuntimeShutdown` retains SQLite ownership whenever a writer cannot
settle. The remaining mixed responsibility is `health/server.ts`, which combines
HTTP routing with workspace probe caching, volatile readiness collection,
diagnostic isolation, operational summary collection, degradation policy, and
status snapshot caching.

This makes health-policy changes depend on transport details and forces tests to
open a TCP listener even when the behavior under test is pure snapshot policy.

## Considered approaches

### A. Extract one health snapshot collector (chosen)

Keep `startHealthServer` as the HTTP adapter for GET/HEAD validation, endpoint
routing, status codes, JSON encoding, and listener lifecycle. Add
`HealthSnapshotCollector` with a small `readiness()` and `status()` interface.
It owns Herdr workspace probe caching, status single-flight caching, one-read
volatile providers, bounded/redacted failures, readiness assembly, and degradation
classification.

This is one deep in-process module: callers learn two reads while all observation
policy stays local and directly testable.

### B. Keep the file intact and only record the audit

Lifecycle safety would be accepted, but HTTP and health policy would remain
coupled. Future provider or degradation changes would still require transport-level
reasoning and tests.

### C. Split readiness, status, every provider, and both caches separately

This creates shallow modules and exposes ordering and shared-read constraints to
the HTTP adapter. The important invariant is one coherent observation, not the
number of files.

## Modules and interfaces

`HealthSnapshotCollector` receives the existing health dependencies and exposes:

```ts
interface HealthSnapshotCollectorPort {
  readiness(): Promise<Readiness>;
  status(): Promise<Record<string, unknown>>;
}
```

The collector owns:

- bounded-concurrency Herdr workspace probes and their short-lived cache;
- database, project, Gateway, lease, and instance-runtime readiness checks;
- one observation of each volatile readiness provider per response;
- isolated, bounded, redacted diagnostics and operational-store failures;
- the existing exhaustive status degradation decision;
- non-caching of snapshots containing collection failures.

`startHealthServer` retains only transport concerns. `ManagedBridgeRuntime`,
the lifecycle ledger, and shutdown remain unchanged because their current
interfaces already hide startup prefix cleanup, writer classification, shutdown
ordering, fencing, and ownership retention.

## Authority and invariants

- `/health` means only that the process can answer and continues to expose build
  identity without dependency probes.
- `/ready` fails closed unless database, projects, Herdr, Gateway/Lark, lease,
  and initial instance reconciliation are usable.
- `/status` is always observational. Degradation never repairs state, changes
  readiness policy, or drives workflow execution.
- SQLite and live dependency providers remain the authorities for their own data;
  caches are bounded latency aids only.
- Provider failures are isolated, redacted, and bounded. One broken diagnostic
  cannot hide sibling diagnostics or fail the HTTP handler.
- One response cannot combine contradictory lease or instance-runtime reads.
- Writer registration, reverse phase cleanup, and ownership retention remain
  governed by the existing lifecycle ledger and shutdown module.

## Verification

Add collector-level tracer tests for fail-closed readiness, isolated diagnostic
failure, and cache behavior. Keep the HTTP tests as contract coverage for methods,
paths, status codes, and JSON responses. Add architecture guards that the server
does not inspect stores/providers or implement degradation policy. Run lifecycle,
shutdown, health, architecture, typecheck, build, documentation, and full-suite
gates without installing, restarting, or pushing.
