# Ring Safety-Scan Observability

## Problem Statement

The approved per-Pane Delivery Ring plan requires the R1 contraction gate to
show zero unexplained safety-scan discoveries over an agreed production
observation window before T9 removes the legacy lane scheduler. The production
`RingDeliveryEngine` currently exposes only `lastRefillAt`. It does not identify
scheduled safety scans or report whether a scan discovered durable work that
was absent from the process cache, so this gate cannot be evaluated from
`/status`.

The live deployment already reports zero actionable legacy and unscoped debt,
zero ownership mismatches, no active Ring claim, healthy SQLite integrity and a
ready Delivery Engine. A 123-second non-mutating smoke had no status-poll
failures, and the 20,000-row/200-scope cold-discovery fixture completed its
64-head query in about 655 ms against the intended indexes. Those facts do not
replace the missing safety-scan evidence.

## Solution

Add process-lifetime safety-scan evidence to the existing `DeliverySnapshot`:

- `safetyScanRuns`: successfully completed scheduled maintenance scans;
- `safetyScanDiscoveries`: new durable reply IDs accepted into the process
  cache by those scans;
- `lastSafetyScanAt`: completion time of the latest successful scan;
- `lastSafetyScanDiscoveryAt`: completion time of the latest scan with one or
  more discoveries.

Only the periodic maintenance callback is a **safety scan**. Startup recovery,
post-commit notification refill, retry wake-up, scope advancement and explicit
recovery refill remain ordinary refills and do not affect these fields.
Discovery means that a safety-scan result was not already present in either the
scope Ring or the oversized-item slot and was accepted for execution. Duplicate
hydration is not a discovery. The counters are diagnostic process state: they
reset on service restart, so an R1 observation window must fit within one
verified process lifetime.

No SQLite schema, durable delivery record, claim/settlement behavior, retry,
fairness, quarantine, ordering, no-replay rule or Core protocol changes.

## User Stories

- **SCN-1 — Empty safety scan:** An operator observes a completed scheduled
  scan with `safetyScanRuns` incremented, zero discoveries, and a current
  `lastSafetyScanAt`.
- **SCN-2 — Missed hot-path work:** If committed Ring work is absent from the
  in-memory cache, the next scheduled scan hydrates it once and increments
  `safetyScanDiscoveries`; delivery behavior remains unchanged.
- **SCN-3 — Duplicate discovery:** A scheduled scan returning a reply already
  cached does not increment discoveries.
- **SCN-4 — Non-safety refill:** Startup, notification, retry and advancement
  refills never change the safety-scan counters.
- **SCN-5 — Failed scan:** A failed scheduled scan retains the existing engine
  degraded/failure behavior and does not count as a completed run.

## Implementation Decisions

### Domain Model

This is a diagnostic projection inside the Delivery Operations context. It
does not introduce an aggregate, repository or durable event. The existing
durable outbox remains authoritative; the in-memory Ring remains an
acceleration cache.

`SafetyScanObservation` is process-lifetime evidence, not delivery state. Its
invariants are:

- only a successfully completed periodic maintenance refill increments runs;
- a reply contributes at most once to discoveries within that scan because
  existing cache membership is checked before offer;
- duplicate or rejected hydration does not count;
- timestamps use the engine's injected clock and are emitted as ISO-8601;
- restart resets the evidence and therefore starts a new observation window.

### Architecture

`RingDeliveryEngine` owns refill cause and discovery classification because it
alone knows both the trigger and cache membership. The domain-owned
`DeliverySnapshot` carries the four scalar fields. Existing health/status
composition exposes that snapshot without adding a new persistence or adapter
interface.

The refill path receives an internal cause. Only `maintenance` updates the
safety counters. The offer path returns enough internal outcome information to
distinguish new acceptance from duplicates without changing the public
`DeliveryEngine.enqueue()` contract.

### Behavior & Failure Modes

A scan is counted only after its complete paginated refill succeeds. Discovery
count is accumulated for newly cached reply IDs during that successful scan.
If any page fails, the existing `degraded`, `recoveryReady=false`, and
`lastFailureAt` behavior remains authoritative and neither the completed-run
counter nor scan timestamps advance. Delivery claims and external effects are
unchanged.

Concurrent/coalesced refill requests continue to share the existing in-flight
promise. A maintenance tick that coalesces behind another refill did not run a
distinct safety scan and is not counted; the next maintenance timer remains
the next observation opportunity.

### Compatibility & Migration

The health JSON gains additive fields only. Older consumers that ignore unknown
fields remain compatible. No historical backfill is possible or claimed, and
there is no database migration.

## Testing Decisions

- Extend `tests/ring-delivery-engine.test.ts` at the public `snapshot()` seam.
- Establish Red for SCN-1 through SCN-5 using the injected clock, refill port
  and maintenance scheduler.
- Assert a missed item is still claimed/delivered exactly once; metrics must not
  alter the external-effect path.
- Extend the health/status snapshot test only if its fixture enumerates every
  DeliverySnapshot field rather than forwarding the object structurally.
- Run the affected Ring/health tests, architecture check, typecheck, build and
  the full suite with one worker when host contention makes the default
  parallel suite exceed per-test timeouts.

## Out of Scope

- Persisting observations across restart.
- Selecting or closing the R1 observation window.
- Performing the production rollback rehearsal.
- Removing legacy lane code or schema in T9.
- Repairing the repository-wide pre-existing `public:audit` findings.
- Changing delivery scheduling, retries, ordering, quarantine or Core events.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in place, because the change is narrow and task-owned files do not
  overlap the user's existing `TODO.md` or untracked documents.
- Branch and starting revision: `main` at `526b5360`.
- Existing user changes preserved: `TODO.md` plus the three untracked research,
  spec and handoff documents shown by `git status`.
- Fresh baseline: `npm test -- --maxWorkers=1` passed 288 files and 4,154 tests;
  the focused production-shaped query-plan tests passed 2/2, including about
  655 ms for the 20,000-row fixture; the installed service remained ready.
- `npm run public:audit` fails on pre-existing tracked historical documentation
  and test paths. This remains a separate T9 gate blocker and is not widened
  into this observability patch.
- Gate 1 design and Gate 2 specification approved on 2026-10-06.
