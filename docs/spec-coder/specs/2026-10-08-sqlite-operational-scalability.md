# SQLite operational scalability

## Problem Statement

Herdr Agent Swarm keeps workflow intent, Core projection evidence, Lark delivery
state, recovery evidence, operational diagnostics, and audit history in one
SQLite database. Keeping these decisions in one database is valuable because
Projection, Outbox, checkpoint, and recovery changes can commit atomically, but
the current storage paths no longer keep hot work proportional to current work.

The production database inspected on 2026-10-08 was 4,467,585,024 bytes with a
34 MB WAL. About 1.47 GB, or 32.9 percent, was already on SQLite's freelist, but
`auto_vacuum` was disabled. The database contained 97 application tables, 122
explicit indexes, and 111 migration markers. Its largest allocations were
`outbound_replies` at about 1.58 GB, `core_event_inbox` at about 556 MB,
`answer_timeline_items` at about 162 MB, and `conversation_segment_items` at
about 146 MB.

Several recurring paths scale with retained history rather than current work:

- timeline projection rewrites and reparses the complete accumulated timeline;
- Turn Card convergence loads frozen history that ordinary live rendering no
  longer needs;
- Core ingestion repeats point reads and stores query-critical discriminators
  only inside JSON;
- Delivery Ring refill performs several checkpoint queries per scope;
- status and readiness execute synchronous queries on the main Node thread;
- startup recovery and integrity work can hold or compete for SQLite locks for
  unbounded periods;
- retention removes some rows but neither bounds the largest evidence tables
  nor returns free pages to the filesystem;
- current schema, historical compatibility, lease-fenced table membership, and
  retention classification are maintained in separate manual registries.

The intended change is to make ordinary live work proportional to its delta,
bound historical and diagnostic work, preserve a small permanent audit trail,
and provide a safe operator-owned production compaction path. It must not weaken
the existing no-replay, delivery ordering, uncertainty, quarantine, lease, or
cross-table atomicity guarantees.

## Solution

Retain one online writable SQLite database and deliver the work in four
independently deployable releases:

1. establish SQLite safety, observability, cheap health probes, and fast
   current-schema test/bootstrap paths;
2. replace full-history hot paths with delta persistence, bounded reads, and
   set-based Delivery Ring reconciliation;
3. introduce normalized event discriminators, a bounded Session Activity
   projection, canonical schema metadata, permanent audit skeletons, and
   reference-aware payload retention;
4. add an operator-controlled backup, retention, `VACUUM INTO`, validation,
   atomic replacement, restart, and rollback workflow.

The main process keeps one fenced synchronous writer connection. Its lock waits
must be short and observable; retryable lock contention is rescheduled outside
the synchronous transaction. Expensive status and integrity reads use an
isolated read-only Worker. This milestone does not convert the complete store
surface to asynchronous RPC and does not split live state across databases.

Complete payloads have a default 30-day retention window. Once a record passes
the Retention Barrier, its large payload may be removed while a permanent Audit
Skeleton retains identity, hash, state, timestamps, ownership, and recovery
relationships. Records with uncertain effects, active quarantine, unresolved
recovery, open gaps, pending prerequisites, or incomplete replacements never
pass the barrier.

## User Stories

### SCN-1: Long Core output remains incrementally projectable

When a session produces a long sequence of JSONL deltas, ingesting one new event
updates only the changed timeline and Session Activity items. It does not
rewrite, reparse, or rerender the complete historical timeline or frozen pages.

### SCN-2: Delivery Ring refill is bounded by the requested page

When startup, overflow, retry, or the safety scan refills multiple Delivery
Scopes, one set-based query derives each scope's checkpoint, authoritative
blocker, maximum order, candidate head, and retry time. Only changed
checkpoints are written, and the look-ahead sentinel is not reconciled.

### SCN-3: Lock contention cannot silently expire a valid lease

When SQLite is busy, a synchronous wait cannot exceed the configured heartbeat
safety budget. `SQLITE_BUSY` and `SQLITE_LOCKED` are retried with bounded jitter
outside the transaction until the known lease safety deadline. A confirmed
owner/token change or exhausted deadline remains a lease-loss failure.

### SCN-4: Health and status do not monopolize the writer

Readiness performs a constant-time probe. Status serves a bounded cached
snapshot and refreshes expensive diagnostics through a read-only Worker.
Concurrent callers coalesce, stale data is explicitly timestamped, and a
transient refresh failure does not trigger a tight retry loop.

### SCN-5: Safe terminal payloads compact without erasing evidence

After the 30-day window, a terminal Core or Delivery record is compacted only
when every Retention Barrier predicate succeeds. Its Audit Skeleton remains
queryable. Uncertain, quarantined, referenced, incomplete, or otherwise unsafe
records remain intact.

### SCN-6: Schema metadata cannot drift silently

Adding a durable table without declaring its fencing, retention, and integrity
classification fails schema validation. Migration identifiers are unique and a
current database takes a verified schema-epoch fast path rather than replaying
the historical compatibility chain.

### SCN-7: Session Activity survives restart without duplicating history

Task List, active and recent Subagents, active and recent Tools, current Model,
Current Goal, compaction count, and optional token/context usage reconstitute
from a bounded per-Pane/session projection. Conversation Segment remains the
per-Turn history authority, and Worker activity uses its parent Primary Pane
scope rather than creating a Worker Delivery Ring.

### SCN-8: Recovery work is bounded and failure-safe

Startup and periodic recovery claim deterministic bounded batches. A failure
rolls back the current batch, preserves idempotency and evidence, and leaves
later batches discoverable without holding one write lock over the entire
backlog.

### SCN-9: Production compaction is reversible

With a maintenance window of at most 15 minutes, the operator stops admission
and the service, verifies lease release, creates and validates a consistent
backup, compacts into a new database, validates physical and semantic
integrity, atomically replaces the database, restarts Swarm, and runs smoke
checks. Any failed gate restores the original database and stops the rollout.

## Implementation Decisions

### Domain Model

The existing bounded contexts remain authoritative:

- **Conversation Projection** owns Conversation Segment and Session Activity
  read models. Conversation Segment is per-Turn durable history. Session
  Activity is the bounded current view for one exact Pane/session.
- **Delivery and Operations** owns Delivery Intent, Prepared Delivery,
  Delivery Scope, Delivery Ring, Delivery Checkpoint, recovery evidence,
  Retention Barrier, Audit Skeleton, and Maintenance Cycle.
- **Agent Input**, **Primary Session**, and **Worker Runtime** retain their
  existing identities and lifecycle rules. The storage optimization does not
  reinterpret those states.

The new local terms are:

- **Hot State**: state required to make current workflow decisions or render the
  current view. Hot State remains fully queryable and is never time-pruned.
- **Durable Evidence**: facts required to establish ordering, idempotency,
  effect certainty, recovery, and no-replay decisions.
- **Audit Skeleton**: the permanent, payload-free identity, hash, lifecycle,
  ownership, timestamp, and relationship record retained after safe compaction.
- **Retention Barrier**: the single policy that proves a payload is no longer
  needed for workflow, recovery, or user-visible reconstruction.
- **Maintenance Cycle**: the operator-owned, resumable sequence for backup,
  compaction, validation, activation, restart, and rollback.

`SessionActivitySnapshot` is a bounded projection root identified by Delivery
Scope/Pane identity and fenced by owner generation, native session, and source
epoch. Its revision advances monotonically for the exact identity. Activity
items are identified by `(scope, kind, itemId)` and are updated from canonical
Core events. Terminal items are bounded by count or expiry; complete
conversation content is not part of this aggregate.

`RetentionBarrier` is a policy, not a mutable record. It accepts normalized
checkpoint, reference, recovery, quarantine, replacement, and projection facts
and returns an eligible/refused result with a stable reason. The SQLite
retention application path enforces that result in the same transaction that
creates or completes the Audit Skeleton.

The following invariants apply:

- **INV-1 — Authority preservation:** Core JSONL remains conversation-order
  authority; SQLite projections and cards cannot reorder it.
- **INV-2 — Atomic delivery intent:** a projection change and its Delivery
  Intent reservation remain one transaction.
- **INV-3 — No replay:** retention, migration, and maintenance cannot make a
  possibly attempted Agent Input eligible for resubmission.
- **INV-4 — Uncertainty preservation:** uncertain effects, active quarantine,
  unresolved recovery, open gaps, pending prerequisites, and incomplete
  replacements retain their complete evidence.
- **INV-5 — Fenced writer:** one owner/token retains the right to mutate
  workflow state. Trigger fencing remains until a separately proven design
  replaces it.
- **INV-6 — Bounded live work:** recurring live paths are bounded by the event
  delta, active page, refill page, or configured recovery batch rather than
  total retained history.
- **INV-7 — Permanent accountability:** payload compaction never removes the
  stable identifiers, hashes, outcome, timestamps, ownership, and recovery
  linkage required for audit.
- **INV-8 — Reversible maintenance:** the active database is never replaced
  until the candidate passes physical, foreign-key, schema, and semantic
  checks; failure preserves or restores the prior active database.

### Architecture

#### SQLite runtime module

The SQLite runtime remains an infrastructure adapter. Its external interface
stays small: open/close, labeled transaction execution, readiness probe, and
bounded runtime diagnostics. It owns PRAGMA configuration, transaction
receipts, duration measurement, busy classification, and rollback cleanup.
Callers provide a fixed low-cardinality operation label and never provide SQL
or bound values for logging.

The synchronous `busy_timeout` must remain below the lease heartbeat safety
budget. Retryable lock failures leave the synchronous transaction and are
rescheduled with bounded jitter. Configuration validation rejects combinations
where the maximum synchronous lock wait plus retry allowance can consume the
lease safety margin.

Lease trigger fencing remains the database enforcement mechanism. A canonical
schema manifest classifies each current table as lease-fenced or explicitly
exempt. Trigger definitions are derived from that manifest. Expiry comparisons
use normalized millisecond values rather than repeated textual `julianday()`
conversion where the compatible migration can prove exact values.

#### Diagnostics read module

The existing integrity Worker becomes the isolated diagnostics read adapter.
It opens the database read-only with `query_only=ON` and a bounded busy timeout.
It serves:

- constant-time connectivity evidence;
- a bounded Operational Summary snapshot;
- frequent index-backed semantic checks;
- a lower-frequency full `quick_check` and foreign-key audit.

The health application layer serves the last timestamped successful snapshot
while one refresh is active. Busy/locked is reported as temporary audit
unavailability and triggers a bounded near-term retry; it is not reported as
corruption. Fatal physical integrity failure prevents normal writer admission.

#### Projection write modules

Conversation projection receives canonical event DTOs and applies timeline
deltas. It persists changed items and aggregate flags without exposing table
operations to coordinators. Ordinary Turn Card reads return segment metadata,
the active page, and only items at or after the active page cursor. Explicit
historical recovery uses a separate bounded interface.

Core Inbox normalizes `event_type`, `submission_id`, `channel`, and `call_id` at
ingestion. Fixed statements are prepared once per store. Existing event and
lane evidence is loaded once per input batch entry, and inserted sequence data
is returned or derived without a redundant read. The original bounded/redacted
event JSON remains available until the Retention Barrier permits compaction.

Delivery Ring refill uses a set-based scope-page query. Checkpoint writes are
conditional on an actual watermark change and occur in the same transaction as
the authoritative head calculation. Scheduler bypass behavior never changes
the safe retention/checkpoint predicate.

Queue feedback has a narrow projection operation that updates only queue
fields, revision, and timestamp. It reserves a new delivery only for changed
views and does not invoke complete Run Card/timeline persistence.

#### Session Activity projection

`session_activity_snapshots` stores exact scope and runtime identity, revision,
source cursor, current model, current goal, last Turn state, compaction count,
optional usage, and update time. `session_activity_items` stores bounded task,
agent, and tool items keyed by scope, kind, and item identity.

Existing Core events drive this projection. `token_usage/context_usage` remains
nullable until Herdr Core exposes a stable protocol event; adding that producer
is outside this repository milestone. No full Human or Assistant message is
copied into Session Activity.

#### Retention and maintenance modules

Retention evaluates bounded candidate pages through one `RetentionBarrier`
implementation. It never receives an unrestricted table name or SQL fragment.
Each accepted compaction writes or confirms an Audit Skeleton and removes only
the approved large payload in one fenced transaction. Work is keyset-paged,
time-budgeted, and yields between transactions.

The maintenance command is an operator adapter. Its public result identifies
the completed phase, backup and candidate identities, validation results, and
whether activation or rollback occurred. It never silently deletes the backup
or changes service state after an unresolved validation failure.

Source dependencies continue to point from coordinators/application workflows
to domain-owned ports and from SQLite/CLI implementations inward to those
ports. Cards, Lark adapters, and Herdr adapters do not gain direct SQL access.
`src/main.ts` remains the composition root.

### Behavior & Failure Modes

- A Timeline delta conflict is resolved by the existing event identity and
  projection revision. A duplicate produces no additional write; an
  incompatible duplicate opens the existing recovery/gap path.
- A stale Session Activity update loses its owner/session/revision conditional
  write and cannot overwrite a new generation.
- A busy write is rolled back before retry scheduling. The transaction callback
  is never suspended across an `await`.
- A status Worker timeout returns the prior timestamped snapshot and degraded
  freshness metadata without blocking the main writer.
- Retention refusal is non-mutating and records a bounded reason count. An
  accepted row is compacted once; repeated maintenance returns the same Audit
  Skeleton.
- An interrupted retention batch leaves earlier committed batches valid and
  later candidates discoverable.
- An interrupted database candidate build leaves the active database and its
  backup untouched. Activation uses an exact expected source/candidate identity
  and an atomic same-filesystem rename.
- Startup performs a read-only physical preflight before schema mutation. Fatal
  corruption fails closed. After migrations, semantic validation gates writer
  admission and readiness.
- Each production release stops when readiness degrades, Ring backlog grows
  persistently, new gaps or uncertain quarantines appear, lease ownership is
  lost, or SQLite busy/slow-transaction signals regress materially.

### Compatibility & Migration

Current public commands, Lark behavior, delivery identities, Core order, and
stored lifecycle values remain compatible. New event discriminator and Session
Activity columns/tables are additive before readers switch to them.

Migration metadata gains a current schema epoch and fingerprint while retaining
historical migration rows. Duplicate historical identifier `89` is represented
explicitly in compatibility validation rather than rewritten destructively in
an existing database. New migration definitions must have unique identifiers.

Fresh databases create the current baseline once. Existing databases apply only
missing ordered migrations and then record the verified fingerprint. A current
fingerprint enables the startup fast path; any mismatch falls back to safe
inspection and fails closed if it cannot be explained by a supported migration.

Retention support is expand-and-contract:

1. add normalized metadata, Audit Skeleton fields/tables, and dual-write where
   required;
2. backfill hashes and discriminator columns in bounded resumable batches;
3. switch reads and integrity checks to the normalized representation;
4. enable 30-day compaction only after equivalence checks pass;
5. remove duplicate snapshot payload writes only after old rows remain readable.

Production database files and sidecars are forced to mode `0600`; the systemd
unit uses `UMask=0077`. Custom database paths must be regular, owned,
non-symlink files under a private writable directory on a filesystem suitable
for SQLite WAL.

## Testing Decisions

- SCN-1/INV-6: statement-count and persistence round-trip tests prove one new
  event writes only its delta and active-page rendering does not hydrate frozen
  history. Long-output fixtures verify linear growth.
- SCN-2/INV-2: production-shaped `EXPLAIN QUERY PLAN`, statement-count, rollback,
  duplicate, uncertain, quarantine, and multi-scope tests verify set-based
  refill without changing order or checkpoint safety.
- SCN-3/INV-5: two-handle contention tests cover busy retry, heartbeat safety,
  stale owner loss, and trigger enforcement on every manifest table.
- SCN-4: health integration tests prove readiness is constant-time and status
  uses a read-only Worker, coalesces refreshes, exposes freshness, and preserves
  the last good snapshot across transient busy failures.
- SCN-5/INV-3/INV-4/INV-7: retention tests exercise every acceptance and refusal
  predicate, repeated batches, rollback, crash/reopen, and permanent Audit
  Skeleton reconstruction without exposing compacted payloads.
- SCN-6: schema tests compare fresh baseline and fully migrated databases,
  reject duplicate new migration IDs, compare manifest tables with
  `sqlite_master`, and ensure every mutable table is fenced or explicitly
  exempt.
- SCN-7: Session Activity projection round trips Primary and Worker activity,
  generation changes, duplicate events, restart, compaction, and bounded
  terminal-item retention.
- SCN-8: bounded startup/recovery tests assert candidate limits, transaction
  rollback, continuation cursors, and no starvation.
- SCN-9/INV-8: maintenance tests use file-backed databases and injected failures
  at backup, validation, activation, restart, and smoke phases. They verify
  byte-preserving rollback and database permissions.
- Architecture checks continue to enforce that domain ports do not import
  SQLite, Lark, or systemd representations.
- Every release runs focused tests, typecheck, build, architecture check,
  public audit, and the full Vitest suite before installation.

Performance acceptance uses deterministic work bounds rather than fragile wall
clock assertions. Production rollout records before/after transaction latency,
busy/locked counts, status refresh duration, Ring backlog, database/WAL bytes,
freelist bytes, and retention counts.

## Out of Scope

- Splitting live workflow state into multiple writable databases.
- Replacing trigger-based lease fencing with transaction-only checks.
- Automatically compacting uncertain, quarantined, unresolved, or referenced
  records.
- Changing Core conversation ordering, Agent Input eligibility, delivery scope,
  CardKit frozen-page, or external-effect retry semantics.
- Implementing the Herdr Core `token_usage/context_usage` producer; the Swarm
  projection remains ready for that future optional event.
- Deleting the original production database or its validated backup as part of
  the maintenance run.
- Pushing commits or opening a pull request.

## Further Notes

- Workspace: repository root.
- Mode: in-place, serialized. The current worktree contains approved but
  uncommitted rejected-root/Card-dismissal recovery work that overlaps SQLite
  files. That work must complete its own verification and atomic commit before
  SQLite optimization implementation begins. Parallel mutation in this shared
  checkout is prohibited.
- Branch: `main`.
- Starting revision: `acd05b8aba1db01c01c086075aa3570d3b054e63`.
- Initial changes: 24 tracked modified files plus existing untracked build,
  research, specification, plan, handoff, Card Dismissal source, and test paths;
  they remain user/previous-task owned and must not be swept into SQLite
  optimization commits.
- Dependency preparation: existing locked dependencies were used; no install or
  dependency mutation was required.
- Fresh baseline: `npm test` passed 287 files and 4,137 tests on 2026-10-08 in
  106.77 seconds. The earlier focused typecheck/build/architecture checks were
  green, but each implementation ticket must run its own fresh affected checks.
- Production maintenance authorization includes installation, restart,
  retention migration, and compaction under the approved staged rollout and
  15-minute maintenance window. It does not authorize deletion of the original
  database or backup.
- Gate 1 design approval: approved by the user on 2026-10-08.
- Gate 2 specification approval: approved by the user on 2026-10-08.
