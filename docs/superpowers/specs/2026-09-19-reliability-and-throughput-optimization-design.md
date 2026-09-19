# Reliability and Throughput Optimization

**Date:** 2026-09-19

## Problem

The bridge is healthy and event-driven, but a read-only optimization audit found
several independent sources of correctness risk and avoidable work:

- a reconciliation request can be stranded in a narrow promise-completion race;
- the publisher can claim stale delivery intent before startup repair runs;
- a transient startup view failure is logged as deferred without a retry owner;
- targeted Herdr work repeatedly collects the same full snapshot;
- Answer streaming repeats expensive Markdown pagination and rendering;
- process-lifetime sets and command-result maps can retain stale entries;
- historical SQLite rows make startup and operator queries grow without bound;
- external observation, status collection, logging, and lifecycle polling have
  avoidable burst or long-running resource costs.

These problems should be corrected without changing the bridge's authority
model. SQLite remains the only durable workflow and queue authority, Herdr
remains authoritative for live runtime identity, and Lark remains a projection.
No optimization may replay a Prompt, rewrite an uncertain delivery effect, or
create a shared Primary/Worker reconciliation executor.

## Goals and success criteria

1. No accepted reconciliation request can remain pending solely because it was
   submitted between waiter settlement and active-drain cleanup.
2. Startup repair reserves or retires eligible durable view work before the
   publisher can claim it.
3. A transient per-binding startup view failure has an explicit bounded retry
   owner and is visible in operational diagnostics until recovery.
4. A batch of targeted pane reconciliations and one pane-retention pass each
   use one bulk Herdr snapshot, except for a final fresh pre-close fence.
5. A streaming Answer update does not paginate or render the same page twice.
6. Process-local wake-up and result structures are bounded or cleared when
   their authoritative lifecycle ends.
7. Startup recovery, `/sessions`, and Answer continuation queries operate on
   outstanding or bounded data instead of lifetime history or JSON extraction.
8. Global observation and status work have explicit concurrency/coalescing
   bounds. Long-running local logs have an enforceable size bound.
9. Reinstalling an already validated immutable release does not reinstall
   production dependencies. Lifecycle polling preserves fail-closed listener
   ownership while reducing subprocess work.
10. Remove only redundancy and dead code proven by repository references or
    compiler checks; do not perform size-driven speculative refactors.

## Non-goals and invariants

- Do not add a payload-bearing application in-memory queue. Process memory may
  hold only bounded, coalescible, disposable wake-up or scope state.
- Do not automatically replay work that may have reached TraeX.
- Do not combine Primary and Worker reconciliation queues or failure domains.
- Preserve `pane -> workspace -> all` priority and periodic full reconciliation.
- Do not lower polling or debounce intervals to manufacture lower latency.
- Preserve SQLite transaction boundaries, outbox idempotency, lane ordering,
  frozen Answer pages, uncertain-effect quarantine, and exact-turn fences.
- Keep high-risk approval local to Herdr.
- Do not replace structured Pino logging or make host journal access mandatory.
- Do not change public command semantics merely to optimize internal work.

## Delivery structure

The work is divided into four independently reviewable workstreams. Each one
must retain a green focused suite before the next begins. A workstream may be
shipped or reverted without requiring unfinished later work.

## Workstream 1: correctness and startup recovery

### Reconciliation drain closure

`PriorityReconciliationRunner` remains a domain-free, single-writer scheduler.
Its active promise completion path will clear `active`, then atomically decide
whether pending pane IDs, workspace IDs, or the full bit require another drain.
It will start that drain before yielding ownership. The check is performed in
both success and failure completion paths and is disabled once stopping begins.

Request waiters retain their revision-based coverage semantics. The change does
not resolve pending requests speculatively and does not allow two executors to
overlap. A deterministic test will submit a second request synchronously from
the first request's continuation, in the precise settlement-to-cleanup window.

### Full-hint snapshot invalidation

A full Herdr hint represents an event gap, malformed event, reconnect, or other
broad uncertainty. `WorkspaceSnapshotCache` will expose a full invalidation
operation using its existing generation fence. `HerdrEventRouter` will perform
that invalidation before invoking full-scope consumers. Targeted invalidation
continues to use the existing workspace/pane paths. There will be no second
snapshot cache.

### Pre-delivery recovery phase

Startup will be split at the composition boundary:

```text
lease and database ready
  -> pre-delivery durable repair
       -> interrupted/quarantined delivery reconciliation
       -> obsolete and legacy intent retirement
       -> startup Main/Answer projection reservation
  -> publisher starts and drains repaired durable intent
  -> runtime baselines, Herdr reconciliation, and periodic workflows start
```

Pre-delivery repair may insert, retire, or reserve only work allowed by current
SQLite fences. It must not modify rows that have been claimed, attempted, or
classified as an uncertain external effect. Publisher startup remains the only
point at which repaired intent can create a Lark effect.

### Retry owner for startup views

`StartupViewConverger` will continue processing later bindings after a local
failure, but will return the failed binding identities rather than swallowing
them as success. A focused background recovery component will own those
identities with:

- a bounded de-duplicating set, not card or Prompt payloads;
- one active convergence pass;
- exponential backoff with a configured cap;
- removal only after successful durable convergence or proof that the binding
  no longer needs repair;
- pending count, last failure, and recovery counters in `/status`.

SQLite remains the source from which each retry reconstructs current state. A
process restart may lose the in-memory wake-up set, because startup discovery
recreates the recovery candidates from durable state. Readiness becomes
degraded while known startup view obligations remain unresolved, but `/health`
continues to report process liveness.

## Workstream 2: real-time hot paths

### Batch Herdr snapshots

Primary targeted reconciliation will request one fresh bulk snapshot for the
captured pane batch, build a local `Map<paneId, pane>`, and converge each owned
binding from that immutable batch. Agent-specific foreground probes that cannot
be derived from the snapshot will use a small bounded concurrency limit. The
runner continues to serialize batches and prioritize pane scope.

Pane retention will similarly collect one snapshot per scan and make candidate
decisions from its indexed view. Destructive pane closure retains a final
targeted fresh observation immediately before the close, so batching never
weakens the safety fence.

The bulk observation belongs behind a narrow Herdr adapter port. Coordinators
will not parse raw CLI output or depend on cache implementation details.

### Single-pass Answer rendering

`AnswerPagePlan` will carry the ephemeral page result needed by its consumer:
rendered content, source start/end, overflow state, and continuation metadata.
`AnswerPageWorkflow` will use that result directly instead of rebuilding the
source and rendering again merely to recover `sourceEnd`. These fields are an
in-process calculation result, not durable cache state.

`renderAnswerStreamPage` will calculate the effective suffix-adjusted content
limit before invoking the paginator, so an overflowing page uses one pagination
pass. Existing canonical offsets, protected ranges, frozen-page behavior, and
9,000-character page contract remain unchanged. Incremental Markdown parsing is
deferred until measurements show remaining need; the first change removes only
confirmed duplicate computation.

## Workstream 3: bounded resources and durable queries

### Process-local state cleanup

- On every Herdr socket connection, replace `subscribedPaneIds` with the
  authoritative snapshot rather than only adding IDs. Clear it on stop.
- `SwarmCommandGateway` will retain `CreateWorkerResult` only for callers that
  synchronously consume it. Message-originated commands will complete their
  durable reply path without leaving an entry in the result map.
- External-turn scans will use a small configurable or internal bounded worker
  pool across bindings while preserving the existing per-binding serial fence.

These structures remain hints or synchronous handoff state. None becomes a
second durable queue.

### SQLite query changes

1. Answer continuation existence checks use normalized `stream_page_index`
   instead of `json_extract(payload, ...)`. A composite partial index is added
   only if `EXPLAIN QUERY PLAN` shows the current prompt/kind/state indexes do
   not provide a bounded lookup.
2. Initial-prompt startup recovery adds a durable `NOT EXISTS` predicate for a
   `prompt_jobs.lark_message_id` matching the selection command ID. The current
   unique constraint remains the final idempotency fence.
3. Startup view discovery receives a purpose-built read model containing only
   bindings with unfinished lifecycle state, actionable Answer pages,
   undelivered view revisions, recovery state, or relevant pending outbox work.
   The implementation may batch related latest-run/topic data, but projection
   writes remain in existing workflows and transactions.
4. `/sessions` gains an index led by `chat_id` and bounded keyset pagination.
   Ordering remains lifecycle priority, runtime status, descending activity,
   then binding ID. The first page preserves the current command's useful
   recent-session behavior; continuation is explicit rather than silently
   materializing lifetime history.

Every migration is additive and idempotent. Durable history is retained. Query
plans and behavior are covered by store tests, not inferred solely from a green
full suite.

### Fixed-size idempotency material

Card write paths will stop embedding complete serialized card JSON in SQLite
idempotency keys. The outbound boundary will either use an existing semantic
view revision or serialize once and derive a SHA-256 digest. The chosen key must
distinguish materially different outbound content and remain deterministic
across restart. Payload serialization still occurs exactly once for storage.
Existing records and keys require no rewrite.

### Status coalescing

The loopback health server will accept only `GET` and `HEAD` for its read-only
endpoints. Complete `/status` snapshots will use a very short TTL and in-flight
promise coalescing so concurrent callers share one SQLite aggregate pass. The
cache contains only diagnostics, has an explicit maximum age, and never becomes
workflow authority. `/health` stays lightweight; `/ready` continues to perform
or consume the existing freshness-controlled dependency checks rather than
being inferred from cached `/status`.

## Workstream 4: operations and code simplification

### Bounded private service logs

Pino remains the structured local logger and the canonical unit retains private
file permissions. In the installed service, the application will own one Pino
destination opened from a lifecycle-supplied private log path; foreground
development continues to use stdout. The unit will no longer make systemd own
the append descriptor. A user-systemd timer/service will perform rotation under
the same lifecycle ownership boundary:

1. acquire a lifecycle lock;
2. when `service.log` exceeds 16 MiB, create a new 0600 current file and
   atomically move the old path to `service.log.1`;
3. send `SIGUSR2` to the exact systemd `MainPID`; the application handles only
   that signal by invoking the Pino destination's reopen operation;
4. verify the current path is a regular private file and that the owned process
   has reopened it; retain exactly `service.log.1` and the current file.

The timer never starts another logger and never restarts the bridge. Between
rename and reopen, the sole Pino descriptor may append a bounded tail to `.1`;
after reopen all new records go to the current file. A PID or ownership mismatch
fails closed before signalling. A signal/reopen failure is surfaced and retried,
without deleting either regular file. `SIGUSR2` is reserved for log reopen and
does not trigger workflow shutdown. `swarm:logs` remains bounded to 100 lines
and 1 MiB.

Repeated reconciliation failures will use the existing `FailureLogGate` by
stable failure scope/signature: emit the first failure, bounded aggregate
reminders, and recovery. IDs and secrets are not added to logs.

### Release and lifecycle efficiency

- `stage-production-runtime.sh` will validate and return an already existing
  exact immutable release before copy/install work. It retains the post-stage
  existence check for concurrent first installers. Existing release validation
  must include build identity and direct-directory safety.
- Readiness polling will obtain systemd activity and `MainPID` in one sample,
  poll HTTP independently, and run the host-wide listener ownership check only
  after the expected build is reported. A second matching sample remains
  required. Any disagreement still fails closed.
- `RECONCILE_INTERVAL_MS` receives documented lower and upper validation bounds;
  the default remains unchanged. Values capable of creating continuous scan
  loops are rejected at configuration load.

### Proven cleanup

Remove the unused `progressLine`/`progressLabel`, compiler-confirmed unused
locals/imports/parameters, and repository-unreferenced internal exports after
focused checks establish they are not intended package contracts. Extract the
duplicated terminal-agent startup naming and MCP-argument helpers into one small
runtime module. Replace repeated array-copy grouping and array membership checks
with mutable local buckets/sets whose public result remains readonly.

Cleanup is committed separately from behavioral changes. It must not alter card
text, command syntax, driver arguments, or ordering.

## Error handling and shutdown

- Every new background component is single-flight, stops accepting work before
  shutdown, clears timers, and waits for its active pass.
- Failed reconciliation or view recovery rejects only the captured work and
  immediately considers later pending work.
- Snapshot collection failure leaves canonical SQLite state untouched and is
  retried through existing periodic convergence.
- Batched observation never converts absence in a stale snapshot into a
  destructive action; close paths retain a fresh targeted fence.
- Status cache failures are not cached as healthy responses. Concurrent callers
  see the same failure and a later request may retry.
- Log maintenance and release staging never weaken listener ownership checks or
  active-work restart gates.

## Observability

Extend existing diagnostics rather than add a parallel metrics system:

- startup repair: discovered, pending, retry, recovered, and last-failure data;
- Herdr batching: requested pane count, snapshot count, foreground-probe count,
  and duration;
- Answer rendering: pagination calls per projection in deterministic tests and
  duration/size in debug diagnostics without answer text;
- external observation: queued/active binding counts and scan duration;
- status cache: hit, coalesced, refresh, and failure counts;
- log rotation: last attempt, result, and retained sizes through lifecycle
  diagnostics.

Metrics remain bounded and contain identifiers/counts only where already safe.
No Prompt text, terminal output, credentials, or card JSON is added.

## Verification matrix

### Correctness and recovery

1. Reproduce the request-after-waiter-settlement race and prove the second
   request runs without an unrelated event or periodic tick.
2. Assert at most one runner executor is active and stop cannot start queued
   work.
3. Assert a full hint increments the cache generation before either domain
   reads a snapshot.
4. Assert publisher scanning cannot begin until pre-delivery retirement and
   projection reservation complete.
5. Inject one binding convergence failure, prove later bindings proceed, the
   obligation is visible, backoff retries it, and readiness recovers.
6. Re-run Prompt and Worker-turn no-replay, outbox claim, uncertain-effect, and
   frozen-page tests.

### Hot paths and bounds

7. For a multi-pane Primary hint, assert one bulk snapshot and bounded extra
   probes; for pane retention, assert one scan snapshot plus one final pre-close
   check only for the selected candidate.
8. Instrument the paginator and renderer and assert one page computation per
   streaming projection, with canonical offsets unchanged for code fences,
   suffixes, overflow, and frozen pages.
9. Reconnect after a missed pane close and prove the subscription set equals
   the authoritative snapshot; stop leaves it empty.
10. Exercise message-, card-, and Primary-tool Worker creation and prove only
    synchronous consumers temporarily retain results.
11. Prove external observation never exceeds its concurrency bound and remains
    serial per binding.

### Database and operations

12. Verify `EXPLAIN QUERY PLAN` for Answer continuation and `/sessions`; assert
    historical selections and bindings do not increase outstanding startup
    result counts.
13. Verify `/sessions` page boundaries are stable and non-overlapping under its
    complete sort key.
14. Verify concurrent `/status` calls share one aggregate refresh, expired data
    refreshes, failures are retryable, and unsupported methods are rejected.
15. Verify an existing exact release invokes neither artifact copy nor npm; a
    mismatched/invalid release fails safely; concurrent first-stage behavior
    remains atomic.
16. Verify lifecycle polling reduces command invocations while rejecting an
    unexpected listener PID or wrong build.
17. Run log rotation past 16 MiB under an active service fixture and prove the
    exact systemd MainPID handles `SIGUSR2`, the Pino destination reopens the new
    0600 file, only `.1` is retained, and no second writer is created. Also prove
    wrong-PID and reopen-failure paths fail closed without deleting logs.
18. Verify invalid reconciliation intervals fail configuration validation and
    the existing default remains valid.

### Final gates

After each workstream, run its focused tests. After all workstreams, run in
order, without overlapping build and installer tests:

```text
npm test
npm run typecheck
npm run architecture:check
npm run docs:audit
npm run build
git diff --check
```

Before any installation, inspect active Prompt/Worker-turn state and use the
normal restart gate. A force restart requires a fresh explicit authorization.
No push is part of this design. If a push is later requested, inspect the entire
outgoing range, remove any injected `Co-authored-by: TRAE CLI` trailers, and run
`npm run public:audit` first.

## Rejected alternatives

### One monolithic performance rewrite

Combining recovery sequencing, rendering, SQLite read models, and lifecycle
logging in one implementation obscures correctness boundaries and makes rollback
unsafe. Independent workstreams provide clearer evidence and smaller failure
domains.

### Payload-bearing in-memory delivery queue

It could reduce individual SQLite reads but would create a second authority and
lose work on restart. Durable SQLite intent plus disposable wake-up hints already
provides the required latency and recovery model.

### Incremental Markdown parser as the first rendering optimization

It offers a larger theoretical gain but adds cache invalidation and canonical
offset complexity. Removing confirmed duplicate passes is lower risk and must be
measured before adding incremental parsing.

### Journald-only logging

It would solve rotation but makes supported inspection depend on host journal
access, contrary to the standalone service contract. The private local Pino log
and bounded `swarm:logs` interface remain supported.

### Aggressive parallel reconciliation

Parallel passes would reduce latency at the cost of competing observations and
SQLite transitions for the same owner. Batching external reads and bounding
independent probes obtains most of the benefit while preserving single-writer
semantics.
