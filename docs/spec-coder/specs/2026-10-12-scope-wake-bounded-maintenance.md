# Scope-aware Delivery Wake and Bounded Maintenance

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The outbound path already hands an exact prepared delivery to the process-local
Ring after commit, but the same commit also emits a generic wake that starts a
global durable refill. That refill repeats maintenance, quarantine traversal,
and all-scope discovery for work the Ring already knows about.

Global Ring maintenance also groups expired-claim recovery, rejected-review
cleanup, and historical snapshot coalescing inside one SQLite writer
transaction. Post-deployment diagnostics observed 110 slow
`sqlite.prepared-delivery-store.write` transactions with an approximately
2.32-second p50 and 2.43-second p95, so unrelated writers and the Node event
loop can wait behind maintenance work.

## Solution

Separate exact delivery handoff from recovery discovery. A post-commit handoff
with prepared work enqueues that work and emits an exact scope hint only; it
must not request a global refill. A hint without exact work may refill only the
identified scope. Startup recovery, retry recovery, and periodic safety scans
remain the only callers allowed to request an all-scope refill.

Split global maintenance into independently bounded operations. Expired claims,
rejected quarantine-review cleanup, and historical Primary Main coalescing
each own a short SQLite transaction. Read-only candidate discovery should occur
before the writer transaction where the existing fencing and compare-and-set
rules permit it; each writer phase must revalidate its candidates. Failure in
one maintenance class must not roll back a successful, unrelated class or stop
exact-scope delivery.

## User Stories

### SCN-1: An exact committed delivery does not trigger global discovery

When an outbound commit returns prepared Ring work, the runtime enqueues it and
continues delivery without scanning every durable scope. Duplicate commit
notifications remain idempotent and do not create a second Gateway effect.

### SCN-2: A scope hint refills only that scope

When a commit or invalidation cannot carry the complete prepared delivery but
does identify its durable scope, the Ring performs one bounded refill for that
scope. Other scopes and global maintenance are untouched.

### SCN-3: Lost hints still converge

Startup recovery and periodic safety scans retain complete all-scope discovery.
Retry timers retain the durable eligibility path. Dropping a process-local hint
may increase latency until recovery, but cannot permanently lose durable work.

### SCN-4: Maintenance classes commit independently

Expired-claim recovery, rejected-review cleanup, and historical snapshot
coalescing run in separately bounded writer transactions. A failure or large
candidate set in one class does not extend or roll back another class's writer
critical section.

## Implementation Decisions

### INV-1: SQLite remains delivery authority

Scope hints and Ring entries are disposable acceleration data. Every external
effect still requires the existing atomic SQLite claim and all settlement,
checkpoint, idempotency, quarantine, and no-replay rules remain unchanged.

### INV-2: Exact handoff never implies global recovery

The notifier contract distinguishes exact prepared work, an exact scope hint,
and an unknown durable-work wake. Only the unknown recovery wake may request
global discovery, and production commit writers must use the most specific
available signal.

### INV-3: Maintenance is bounded and independently recoverable

Each maintenance class has its own limit, transaction label, and commit/rollback
boundary. Candidate revalidation occurs inside the writer transaction. Partial
completion is safe because every transition is idempotent and rediscoverable.

### INV-4: Uncertain effects are never replayed

Splitting transactions cannot turn an uncertain or expired claim into automatic
replay. Existing dead-letter, quarantine, Human Review, and effect-certainty
semantics remain authoritative.

### ARCH-1: Work wake carries provider-neutral delivery scope

The outbound notifier/hub owns a small provider-neutral hint type based on
`DeliveryScope`; it does not carry a Feishu card model or mutable store row.
The composition root connects exact work to `enqueue`, exact scope hints to a
bounded scope refill, and recovery-only wakes to the existing global recovery
loop.

### ARCH-2: PreparedDeliveryStore exposes maintenance slices

The store exposes independently callable bounded maintenance operations rather
than one transaction that nests all classes. `RingDeliveryEngine` coordinates
the slices once per global pass and yields between them/pages so exact delivery
continues to have priority.

## Testing Decisions

Add Red-Green coverage proving that an exact prepared handoff performs no
global refill, a scope-only hint loads only that scope, and an unknown recovery
wake still performs global discovery. Preserve startup, retry, safety-scan,
lost-hint, duplicate, and ACK/no-replay coverage.

Add store tests that inject a failure between maintenance classes and prove
earlier committed work remains committed, later work remains rediscoverable,
and no class exceeds its configured batch limit. Instrument transaction labels
separately so live logs can distinguish the three maintenance costs.

Fresh baseline evidence on clean `main` revision
`1a41d3e4891e5093c6a2b56b73b6e3bb89dd9f83`:

- `e17b5d379ff9448391bfe3ad73ee0b3a`: 139 focused Ring/store tests passed.
- `53fa12df8a9f4ac384f8dba5d0dcf033`: `npm run typecheck` passed.

Affected verification must include the Ring recovery/hot-path/store suites,
notification composition tests, typecheck, build, architecture check, docs
audit, and the complete Vitest suite before delivery.

## Out of Scope

No durable dirty-scope table, Delivery Ledger, schema migration, provider
protocol change, Core cursor change, global checkpoint barrier, status-query
optimization, Ring eviction, scheduler deque rewrite, production SQLite edit,
or automatic replay of uncertain effects is included.

## Further Notes

Three approaches were considered. A durable dirty-scope table was rejected as
unnecessary persistence. Retaining generic wakes with only rate limiting was
rejected because it preserves redundant all-scope work. The selected approach
uses the existing in-process notifier with typed scope hints and keeps periodic
global recovery as the convergence safety net. The user selected this design
after the performance audit identified the two concrete bottlenecks.

Workspace mode is in-place in the existing isolated deployment worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `1a41d3e4891e5093c6a2b56b73b6e3bb89dd9f83`. The worktree was clean and
its locked dependencies were already installed. The original user checkout is
not modified.
