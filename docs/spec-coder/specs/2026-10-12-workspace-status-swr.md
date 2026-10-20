# Workspace Cache and Status SWR

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

`WorkspaceSnapshotCache` has separate generation fences for direct-workspace
refreshes and all-workspace refreshes. A direct refresh can publish newer panes
without advancing `allGeneration`; an older in-flight all-workspace request may
then complete, clear every workspace snapshot, and overwrite the newer result.
That violates the cache's role as a low-latency hint layer and can briefly feed
stale Pane topology into reconciliation.

The health collector has a separate readiness snapshot cache with a two-second
TTL. Both `/ready` and `/status` call its strict `read()`. Once the TTL expires,
an observational `/status` request waits for all configured Herdr workspace
probes. Five live samples ranged from 40 ms to 725 ms, matching the cache-boundary
tail. `/ready` must remain strict, but `/status` already treats most diagnostics
as stale-while-revalidate observations and should not block on a previously
successful Herdr snapshot.

## Solution

When a direct-workspace refresh passes its own generation/reset fence and is
ready to publish, advance the all-workspace generation and clear the aggregate
snapshot before publishing the workspace result. Any older all-workspace result
may still return to its original caller, but it can no longer mutate cache state.

Deepen the existing generic `SnapshotCache` with one stale-while-refresh read:
if no successful value exists, perform the same strict/coalesced read as today;
if a value is fresh, return it; if stale, return it immediately and start or
reuse exactly one background refresh. Refresh failure preserves the stale value
and remains visible through a bounded status diagnostic. Failed background
refreshes use cache-local exponential backoff; an expired strict `/ready` may
still probe immediately. Use strict reads for `/ready` and stale-while-refresh
only for `/status`. Workspace retry policy is independent from SQLite
diagnostic retries. The health collector stops admitting detached refreshes
during shutdown and does not finish stopping until an active refresh settles.
Status keeps the last successful snapshot while exposing a bounded list of
workspace IDs from the failed observation.

The design was auto-selected under the active goal's autonomous/default
authority. It adds no timer, worker, queue, persistence, fake readiness value,
or new health endpoint.

## User Stories

### SCN-1: New direct topology cannot be overwritten by an older global read

When an all-workspace refresh starts first, a direct workspace refresh publishes
later and finishes first, and then the all-workspace request completes, cached
reads keep the direct result. The stale all-workspace caller may observe its own
response, but a subsequent global read must perform a new refresh.

### SCN-2: Status is non-blocking after one successful readiness observation

After readiness has one successful Herdr snapshot, an expired `/status` returns
that stale readiness immediately while one background refresh is pending.
Concurrent status calls coalesce on the same refresh. After success, later
status/readiness calls see the new value.

### SCN-3: Ready remains a strict current-health gate

An expired `/ready` request waits for the current Herdr probe and reports its
success or failure. A cold `/status` with no prior readiness value also waits;
the service never invents a ready or not-ready result.

## Implementation Decisions

### INV-1: Publishing any narrower snapshot fences older aggregate publication

The direct result is authoritative only for its workspace, so it invalidates
the aggregate cache rather than trying to merge unknown sibling workspaces.
Generation change, not promise cancellation, prevents stale publication.

### INV-2: Stale-while-refresh requires an existing successful value

SWR never returns `null`, a synthetic result, or a failed refresh. It preserves
the last successful immutable snapshot and starts at most one refresh promise.
A failed result is not cached, records a bounded retry deadline, and degrades
status until a successful observation clears it. The strict read continues to
await an in-flight promise and may bypass the status retry deadline.

### INV-3: Endpoint semantics own cache mode

`HealthSnapshotCollector.readiness()` selects strict read because it is a gate.
`status()` selects stale-while-refresh because it is diagnostic observation.
The generic cache remains unaware of HTTP paths or Herdr semantics.

### ARCH-1: Existing cache modules remain the only owners

Workspace topology ordering stays inside `WorkspaceSnapshotCache`; generic
snapshot freshness stays inside `SnapshotCache`; HTTP server and Herdr adapter
interfaces remain unchanged. `SnapshotCache` owns its active refresh lifetime,
including shutdown admission and settlement.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1

- Add a deterministic interleaving test where direct refresh resolves before an
  older global refresh and prove the newer workspace cache survives.
- Add collector tests with a controllable clock and blocked Herdr probe proving
  stale status resolves before refresh, concurrent status coalesces, refresh
  updates the value, failed refreshes back off, and strict readiness waits or
  bypasses the status backoff.
- Prove exponential retry growth and cap, failed-workspace diagnostics, and
  shutdown settlement without wall-clock races.
- Start a replacement global workspace read before the invalidated older read
  finishes, proving it cannot coalesce onto the stale generation.
- Preserve existing defensive-copy, invalidation, cold-read, failure isolation,
  and readiness concurrency tests.
- Run affected suites, typecheck, build, architecture/docs checks, full Vitest,
  artifact validation, immutable install, and live status latency sampling.

## Out of Scope

No readiness TTL/config change, workspace subprocess batching, synthetic cold
status, SQLite diagnostics redesign, Circuit Breaker change, reconciliation
schedule change, empty Ring eviction, cache persistence, background timer,
new health endpoint, persisted health schema, or production data mutation is
included. The existing status body gains one bounded workspace-readiness cache
diagnostic object.

## Further Notes

Workspace mode is in-place inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `0597f3cadf08358b434753cb1be660c13e863e2a`. The original checkout remains
untouched. Production baseline is ready with `WorkspaceSnapshotCache` TTL 2,000
ms, 11 entries, 68 hits, 28 misses, 24 coalesced refreshes, and zero failures.

```spec-coder-verification
{"record_id":"0d967e768850487fa2902c4a8a0365d4","command":["/usr/bin/npx","vitest","run","tests/workspace-snapshot-cache.test.ts","tests/health-snapshot-collector.test.ts","tests/health-server.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T23:19:53.940832+00:00","result":"3 files and 92 tests passed"}
```
