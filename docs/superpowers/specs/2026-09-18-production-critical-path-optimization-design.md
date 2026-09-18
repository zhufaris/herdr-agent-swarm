# Production Critical Path Optimization Design

## Goal

Improve stability, measured performance, and maintainability across Herdr Agent
Swarm's production-critical paths without changing the Feishu command contract,
card semantics, queue behavior, or durable recovery guarantees. Work proceeds as
risk-driven vertical slices, each with evidence, focused verification, and an
independently reviewable commit. All slices are installed and restarted together
only after the full repository passes its release gates.

Internal module interfaces may change. SQLite changes are permitted only through
forward-compatible migrations that preserve existing production facts.

## Scope

The work covers five production-critical paths in this order:

1. startup, recovery, and shutdown;
2. inbound messages and the Primary Prompt FIFO;
3. Worker scheduling and runtime reconciliation;
4. SQLite transactions, queries, and migrations; and
5. card delivery, retry, dead-letter recovery, and convergence.

The startup and shutdown slice also owns the local operational logging boundary.
The existing Pino structured logger remains the application logger. The service
lifecycle remains the only owner of local log files, permissions, rotation, and
operator retrieval; migrating application call sites to `tslog` is out of scope
because it would add broad type and transport risk without improving the required
local diagnostics.

Tests, operational tooling, and documentation change only where they directly
support those paths. Broad repository cleanup, cosmetic rewrites, and speculative
framework construction are out of scope.

## Delivery Model

Each slice follows the same evidence-first loop:

```text
production evidence
  -> explicit failure mode or measured bottleneck
  -> regression test or repeatable benchmark
  -> minimal stability correction
  -> optimization only where evidence supports it
  -> simplify the code touched by the correction
  -> full slice verification and an independent commit
```

The five slices remain independently reviewable and reversible. Shared modules
may improve incrementally across slices rather than through a single cross-system
rewrite. A slice may produce only an evidence report when no justified code change
exists.

## Evidence and Priority

Every candidate records its path, observable symptom, affected invariant, concrete
evidence, risk level, proposed correction, and verification method. Accepted
evidence includes structured production status or logs, a deterministic test
reproduction, a repeatable benchmark, query counts, or `EXPLAIN QUERY PLAN`.

Priorities are:

- **P0:** prompt replay, lost durable state, broken atomicity, or authorization
  failure;
- **P1:** queue stalls, incorrect convergence or delivery, or unsafe recovery;
- **P2:** measured latency, throughput, query, or resource cost; and
- **P3:** duplicated decisions, broad interfaces, and complex control flow.

P0 and P1 changes require a reproducer or an explicit state-transition proof. P2
changes require repeatable before-and-after results under the same input and
environment. P3 changes are admitted only near a covered critical path and must
remove a named duplicate decision or dependency. Unproven suspicions remain in the
audit record and do not trigger code changes. Existing dead letters and systemd
ownership diagnostics are not attributed to new defects without causal evidence.

## Slice 1: Startup, Recovery, and Shutdown

Audit the fenced lease, startup stages, interrupted observer recovery, graceful
shutdown, bounded waits, periodic-work cancellation, and service-state reporting.
Recovery must detach work that may have reached an Agent and observe it without
replay. Shutdown must leave durable work recoverable and must not wait forever for
an external process.

Evidence includes startup-stage duration, Herdr call counts, repeated scans, stop
latency, in-flight ownership, and restart recovery outcomes. A failure in one
owner's background scan must not prevent other owners from converging, but it must
remain visible in structured diagnostics.

### Local Structured Logging

Pino emits newline-delimited JSON to standard output and standard error. The user
systemd unit appends both streams to the private `service.log`; application code
does not open or rotate that file. This single-writer boundary avoids competing
rotation policies, background transport workers, and shutdown-flush ambiguity.
Existing redaction and `safeLogError` behavior remain mandatory. Production-critical
records should keep stable correlation fields such as `eventId`, `bindingId`,
`promptId`, `paneId`, and `replyId`.

The lifecycle rotates logs only after the service is confirmed inactive. The active
file remains capped at 16 MiB per stopped-state rotation check, and a bounded number
of rotated generations is retained. Every directory and file in the rotation chain
must pass the existing ownership, regular-file, no-symlink, and single-hard-link
checks before mutation. The directory remains mode `0700` and log files mode `0600`.
Rotation must preserve the old chain if a rename fails; a failed safety validation
must leave all files untouched.

`npm run swarm:logs` keeps its compatible bounded default: the final 100 complete
lines from at most the final 1 MiB of the active log. Optional arguments add bounded
Agent-oriented diagnosis by line count, byte limit, minimum level, timestamp,
component, and correlation IDs. A flag may include the finite rotated chain in
oldest-to-newest order, and a machine-readable mode emits matching JSONL without a
human header. Parsing is streaming or otherwise explicitly bounded. A malformed or
non-JSON line is skipped when structured filters are active and never causes the
whole diagnostic command to fail. Invalid options, unsafe paths, and unavailable
required files fail closed without revealing configuration secrets.

## Slice 2: Inbound Messages and Prompt FIFO

Audit durable inbound acceptance, idempotency, interrupted claims, ordinary Prompt
FIFO ordering, steering eligibility, and exact-turn supervision. One binding may
run at most one ordinary Prompt. A retry of ingress or delivery must never repeat a
TraeX prompt.

Evidence includes queue and claim latency, scan volume, duplicate-message tests,
owner-key serialization, and state transitions for never-started, running,
detached, uncertain, completed, failed, and cancelled work.

## Slice 3: Worker Scheduling and Runtime Reconciliation

Audit Worker turn acceptance and dispatch, generation and runtime fencing, exact
turn identity, scheduler wake-ups, Herdr snapshot reconciliation, orphan handling,
and shutdown observation. Herdr events remain bounded hints; a fresh snapshot or
targeted exact observation remains the convergence authority.

Evidence includes per-instance scan and dispatch counts, wake-up coalescing, Herdr
calls, scheduling fairness, stale-generation rejection, and recovery of interrupted
observers without replay.

An exact external TraeX turn may become durably idle without emitting a matching
`task_complete` or `turn_aborted` transcript event. The observer must not infer
success, wait forever, or replay the request. It may fail the Prompt closed only
after two distinct post-start Herdr observations report `idle` or `done` and the
exact transcript cursor produces no new observation between them. Transcript
activity, a non-idle runtime state, or an identity change resets the confirmation.
The final transition is atomic and fenced by binding generation, Pane, Agent
session, Prompt, exact turn ID and start time, active attachment, Run Card
generation, and the durable idle/done state. A successful transition publishes a
failed outcome with unknown execution result and wakes the durable FIFO; it never
claims success and never resubmits the Prompt.

## Slice 4: SQLite Transactions, Queries, and Migrations

Audit atomic aggregate transitions, transaction duration, repeated reads, record
mapping, index coverage, query plans, and migration behavior. One `SqliteContext`
continues to own production transitions that must commit together. Module splits
must not emulate a transaction across separate connections or repositories.

Migrations are append-only and forward-compatible. New columns must remain
readable for old records through an explicit default or backfill. Empty databases,
upgrades from supported schemas, and repeated startup must all pass. Indexes are
added only for demonstrated query-plan problems. Schema changes update records,
domain contracts, fixtures, tests, and architecture documentation together.

Production database inspection is read-only. A live SQLite database is never
copied without its WAL and SHM companions. Destructive experiments use temporary
test databases.

## Slice 5: Card Delivery and Recovery

Audit durable intent creation, lane ordering, Gateway delivery checkpoints,
CardKit stream lifecycle, retry classification, dead letters, quarantine recovery,
frozen Answer pages, and Main Card convergence. Delivery intent and the workflow
state it represents must commit before an external call. A delivery retry may
repeat only the Gateway effect.

Evidence includes lane drain and retry counts, rejected or redundant CardKit
updates, convergence delay, delivery checkpoint transitions, and recovery of
uncertain effects. Frozen pages remain immutable and continuation uses a new card.

## Error and Recovery Model

The implementation preserves four distinct outcomes:

- work proven not to have executed may be reclaimed or dispatched;
- work that may have executed becomes detached or uncertain and is observed, not
  replayed;
- retryable external delivery retains its original intent and idempotency identity
  and retries in lane order; and
- permanent or incompatible delivery enters the existing dead-letter or quarantine
  recovery path.

When safety cannot be proven, workflows fail closed. The following boundaries are
non-negotiable:

- exact-turn identity for Primary Prompts and Worker turns;
- binding and instance generation fences;
- the instance lease fencing token;
- atomic workflow state and outbox intent;
- observer detachment during shutdown;
- immutable frozen Answer pages; and
- high-risk approval remaining local to Herdr.

Wake-ups may coalesce or be lost because durable scans provide convergence. A
Herdr socket event never becomes a second source of runtime truth.

## Code Simplification Rules

Simplification targets repeated decisions, dependency breadth, and risky control
flow rather than a repository-wide line-count target. Candidates include duplicate
state transitions, error classification, fence validation, lifecycle or in-flight
tracking, scan coalescing, record mapping, version checks, and repeated parsing or
queries.

An extraction is accepted only when:

- at least two call sites have genuinely identical semantics;
- transaction, logging, and error-classification boundaries remain explicit;
- the new unit has one nameable responsibility;
- consumers depend on fewer capabilities; and
- tests prove behavior remains unchanged.

Large files are not split mechanically. Migration history may remain sequential;
atomic SQLite aggregates stay together; CardKit rendering splits only at named view
boundaries; and queues, observers, or retry loops with different reliability
contracts remain separate. Generic `utils.ts` or `helpers.ts` dumping grounds are
not introduced.

Each simplification commit identifies the duplicate decision or dependency removed.
Pure renames are kept separate from behavior fixes.

## Performance Measurement

There is no arbitrary global percentage target. Each measured path has its own
baseline:

- startup and recovery: stage time, Herdr calls, and repeated scans;
- ingress and scheduling: claim latency, scan volume, and per-key serialization;
- SQLite: query plan, full scans, query count, and transaction duration; and
- delivery: lane drains, retries, redundant updates, and convergence latency.

Measurements use fixed inputs, data size, Node version, and runtime parameters.
Before and after use the same method and report repeatable samples rather than the
single fastest run. An optimization is rejected if it improves throughput while
weakening fairness, FIFO ordering, recovery safety, or observability.

## Verification and Commits

Each slice runs its regression and benchmark seams, focused Vitest files,
`npm run typecheck`, `npm run architecture:check`, and `npm run build`. Any change
spanning persistence, recovery, or shared runtime behavior also runs `npm test`.

The logging portion additionally verifies default-output compatibility, bounded
reads, rotation ordering and retention, permissions, link defenses, atomic failure
behavior, structured filters, malformed records, and machine-readable output. A
representative large fixture demonstrates that configured byte and line bounds are
honored; no throughput claim is required because the design keeps Pino's existing
hot path unchanged.

The intended commit sequence is:

1. audit and measurement infrastructure;
2. startup, recovery, and shutdown;
3. inbound and Prompt FIFO;
4. Worker scheduling and reconciliation;
5. SQLite transactions and measured queries;
6. card delivery and recovery; and
7. final documentation and justified cleanup.

A slice may use separate stability and simplification commits where each is
independently testable.

## Installation and Runtime Validation

After every slice and the full repository pass, inspect the complete diff and commit
sequence, then run the final test, typecheck, architecture, and build gates. Build
and stage the immutable release with `./install.sh`. Before restart, inspect active
Prompts, Worker turns, observers, and outbox work. Use the normal restart safety
gate. A forced restart requires a new explicit user authorization.

After restart, verify build identity, readiness, lease, SQLite integrity, all
configured Herdr workspaces, the Feishu Gateway, startup recovery, and representative
card convergence. The work does not push by default. Before any requested push,
inspect the complete outgoing commit range and pass `npm run public:audit`; suspected
sensitive data blocks the push.

## Acceptance Criteria

The program is complete when:

- every production-critical slice has an evidence-backed audit result;
- every confirmed P0 and P1 issue in scope is fixed and covered by a regression;
- each implemented P2 optimization has reproducible before-and-after evidence and
  no correctness regression;
- each P3 cleanup removes a named duplicate decision or dependency in a covered
  critical path;
- Feishu commands, cards, FIFO, no-replay, fencing, persistence, and recovery remain
  compatible;
- focused tests, the full Vitest suite, typecheck, architecture checks, and build
  pass;
- Pino logs are locally retained and queryable through the supported lifecycle CLI
  with bounded reads, safe rotation, private permissions, and preserved redaction;
- the staged release is installed and the running build is ready and converged; and
- the final report lists commits, evidence, unresolved risks, and why any audit-only
  candidate was not changed.
