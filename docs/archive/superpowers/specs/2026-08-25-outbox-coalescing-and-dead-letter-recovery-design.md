# Outbox Snapshot Coalescing and Classified Dead-letter Recovery

## Status and scope

This design improves two related Lark delivery paths: replaceable binding-status
card updates and recovery of failures that are provably transient. It preserves
the durable-outbox rule: workflow intent is committed before delivery, and a
delivery retry never repeats a TraeX prompt.

The existing 48 dead-letter rows are out of automatic-recovery scope. They store
only `Request failed with status code 400`, without a Lark error code or failure
class, so none can be proven transient. They remain available to the existing
manual retry/dismiss flow.

## Goals

- Collapse replaceable binding-status snapshots before delivery so progress
  bursts do not delay the final completed/failed card state.
- Keep an already selected lane head stable while retaining only the newest
  successor snapshot.
- Classify future delivery failures without persisting response bodies, request
  bodies, credentials, or card payloads.
- Respect Lark rate-limit guidance and distinguish transient, permanent, and
  unknown failures across restarts.
- Automatically recover a dead letter only when its persisted evidence proves
  it transient, with one bounded recovery round.
- Expose enough aggregate diagnostics to explain backlog and recovery decisions.

## Non-goals

- Guessing the cause of legacy generic HTTP 400 records.
- Automatically retrying unknown or permanent failures.
- Coalescing answer-card updates, stream content, stream finish operations, or
  create/reply operations whose individual ordering is meaningful.
- Changing manual dead-letter authorization or replaying prompts.
- Persisting raw Axios/Lark responses.

## 1. Atomic binding-status snapshot coalescing

A replaceable status snapshot is a `card_update` row with a binding ID and no
prompt ID. Its lane remains the existing message/card lane.

`enqueueOutboundReply` performs coalescing and insertion in one `BEGIN
IMMEDIATE` transaction:

1. Read the oldest pending replaceable snapshot for the same binding, target
   card, and lane. Treat it as an in-flight-safe barrier because the dispatcher
   does not currently persist an explicit claimed state.
2. Delete every later pending replaceable snapshot for that exact scope.
3. Insert the new snapshot with its normal idempotency key and delivery order.
4. Commit before waking the dispatcher.

The barrier is never overwritten or removed. If it is actually in flight, its
completion remains valid. If it is merely waiting, it is delivered first; the
newest snapshot follows immediately. This bounds each status-card lane to at
most two pending replaceable rows and prevents a crash window between deletion
and insertion.

Coalescing scope includes `binding_id`, `root_message_id`, `lane_key`,
`kind='card_update'`, `prompt_id IS NULL`, and `state='pending'`. Unrelated cards
or lanes cannot delete each other's work. Existing answer/version coalescing
continues unchanged.

## 2. Durable failure classification

Add nullable additive columns to `outbound_replies`:

- `failure_class`: `transient`, `permanent`, or `unknown`;
- `http_status`: sanitized integer status;
- `lark_error_code`: sanitized integer/string code with a bounded length;
- `auto_recovery_count`: non-negative integer, default `0`;
- `dead_lettered_at`: timestamp of the latest terminal delivery failure.

Legacy rows keep null classification and are treated as `unknown`. Error text
remains bounded and payload-free. The classifier receives the original thrown
error in memory and returns only this safe metadata plus an optional retry
delay.

Classification rules are deliberately conservative:

- `transient`: HTTP 429, HTTP 5xx, connection reset/refused, DNS/transport
  unavailability, and timeout errors. A valid `Retry-After` controls the delay.
- `permanent`: local `PermanentDeliveryError` and an explicit allowlist of Lark
  codes known to mean an invalid/stale target or malformed request.
- `unknown`: all other failures, including HTTP 400 without a recognized Lark
  code. Unknown failures use ordinary bounded retries but never automatic
  dead-letter recovery.

The allowlist is code-owned and tested. It does not infer permanence from error
message substrings when structured status/code evidence is available.

Every failed attempt atomically updates attempt count, next-attempt time,
bounded error text, and sanitized classification metadata. Success clears active
failure metadata while preserving the audit trail available through logs.

## 3. Bounded automatic dead-letter recovery

The dispatcher performs a startup and periodic recovery scan before its normal
delivery scan. A row is eligible only when all conditions hold:

- state is `dead_letter`;
- persisted `failure_class` is `transient`;
- `auto_recovery_count` is `0`;
- the dead letter has cooled down for at least five minutes;
- its durable target still passes the existing target validation when delivery
  is attempted.

Recovery is one fenced SQLite transaction that changes the row to `pending`,
sets `auto_recovery_count=1`, resets per-round `attempt_count=0`, clears the
active error, and assigns a current `next_attempt_at`. The dispatcher then uses
the normal lane ordering and delivery path.

If the recovered row exhausts retries again, it returns to `dead_letter` with
`auto_recovery_count=1` and is never automatically reopened. Manual retry
remains available and does not reset the automatic recovery budget. A manual
retry is an explicit operator decision, but subsequent failure still does not
grant another automatic round.

Rows classified `permanent`, `unknown`, or legacy-null remain untouched. The
first deployment therefore automatically retries zero of the current 48 rows.

## 4. Concurrency and crash behavior

- Snapshot coalescing uses the existing SQLite write fence and a single
  transaction, so insertion cannot be separated from pruning.
- Automatic recovery uses compare-and-set predicates on state, class, recovery
  count, and cooldown. Multiple wake-ups cannot consume the budget twice.
- The existing lane-head query remains authoritative for delivery ordering.
- A process crash after recovery commit is safe: the row is pending and found
  by startup scan.
- A process crash after Lark may have accepted a non-idempotent operation retains
  the current delivery semantics; this design does not claim transport-level
  exactly once. Existing idempotency keys and CardKit checkpoints continue to
  constrain duplicates.

## 5. Diagnostics and operator experience

Structured retry/dead-letter logs add `failureClass`, `httpStatus`,
`larkErrorCode`, and `autoRecoveryCount`. They continue to exclude payloads and
raw response/request objects. Automatic recovery emits a separate event with
reply ID, kind, lane, previous dead-letter time, and outcome.

`/status` adds aggregate dead-letter counts by failure class and the count of
transient rows eligible for automatic recovery. It does not expose payloads,
message bodies, or credentials. A persistent eligible recovery backlog degrades
status but does not independently fail readiness.

The existing `/herdr failures` and manual retry/dismiss controls remain the
operator surface for unknown, permanent, and legacy failures. No bulk retry
button is added.

## 6. Migration

The migration only adds columns and indexes. Existing state constraints and rows
remain valid. All legacy dead letters receive `failure_class=NULL`,
`auto_recovery_count=0`, and are interpreted as unknown. No migration rewrites
or retries historical rows.

Suggested indexes:

- `(state, failure_class, auto_recovery_count, dead_lettered_at)` for recovery;
- retain the current lane/delivery-order indexes for dispatch and coalescing.

## 7. Verification

Focused tests must prove:

1. a burst of binding-status snapshots leaves the barrier plus newest row;
2. pruning and insertion roll back together on failure;
3. different bindings, cards, and lanes never coalesce;
4. answer and streaming operations are untouched;
5. 429, 5xx, timeout, and transport failures persist as transient with safe
   metadata and correct retry delay;
6. recognized invalid-target failures persist as permanent;
7. generic HTTP 400 persists as unknown;
8. legacy null-class dead letters are not recovered;
9. one cooled transient dead letter is reopened exactly once under concurrent
   scans and respects its lane;
10. a second exhaustion is not automatically reopened;
11. logs and status contain classification but not response bodies, headers,
    credentials, or card payloads; and
12. an online backup of the live SQLite database migrates successfully with all
    48 historical rows remaining dead-lettered.

Run focused store/dispatcher/health tests, then `npm run typecheck`, `npm test`,
`npm run build`, and `git diff --check`. Deployment uses the Herdr plugin
restart and requires `/ready=ready`, `/status` healthy or explicably degraded,
and a post-migration query proving no legacy dead letter was reopened.
