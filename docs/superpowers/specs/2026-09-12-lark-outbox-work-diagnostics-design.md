# Lark Outbox Work Diagnostics Design

## Problem

The operational summary currently reports all `state='pending'` outbox rows as
`pendingOutbox` and separately describes lane heads. A claimed row remains
pending while its Lark effect is executing, so the summary cannot distinguish
queued work from a durable in-flight effect. The dispatcher also reports
`activeDeliveries`, but that is process-local and disappears across restart; it
cannot explain an orphaned or owner-loss claim in SQLite.

The existing lane summary also combines row backoff, global app cooldown, and
lane serialization into broad eligible/blocked counters. Operators need an
exclusive breakdown of current durable work without changing delivery behavior.

## Goals

- Partition every pending outbox row into one and only one operational class.
- Report durable in-flight work independently from process-local handlers.
- Separate row retry wait, app cooldown wait, ready work, and work serialized
  behind a lane head.
- Expose the age of the oldest active claim without inventing a timeout policy.
- Preserve existing `pendingOutbox` and `outboxLanes` fields for compatibility.
- Keep diagnostics bounded, identifier-free, and read-only.

## Non-goals

- Adding an `in_flight` database state or schema migration.
- Automatically recovering, cancelling, or timing out an old claim.
- Replacing dispatcher `activeDeliveries`.
- Changing claim, retry, cooldown, quarantine, or readiness behavior.
- Adding per-lane, per-binding, or per-user identifiers to status.
- Defining a production latency or stuck-claim threshold.

## Considered approaches

### 1. Derive an exclusive durable-work partition from SQLite (selected)

Use existing `state`, `claim_attempt_id`, `claimed_at`, lane-head membership,
`next_attempt_at`, quarantine state, and app cooldown. This requires no schema
change and remains meaningful across process restart.

### 2. Report only dispatcher `activeDeliveries`

This is cheap but process-local. A crash erases the metric while the durable
claim remains, and transient observation races can make it disagree with the
database. It cannot classify queued work.

### 3. Add a new persisted `in_flight` outbox state

This duplicates the existing claim protocol and would expand every state check,
migration, trigger, retention query, and recovery path. The current pending row
plus exact claim identity already represents in-flight work.

## Operational model

Add this field to `OperationalSummary`:

```ts
outboxWork: {
  ready: number;
  inFlight: number;
  retryWait: number;
  cooldownWait: number;
  waitingBehindLane: number;
  oldestInFlightAt: string | null;
  oldestInFlightAgeSeconds: number | null;
};
```

Every row with `state='pending'` is classified in this order:

1. **inFlight** — `claim_attempt_id IS NOT NULL`.
2. **retryWait** — unclaimed row is the current durable lane head and its
   `next_attempt_at` is later than the observation time. Row backoff takes
   precedence over app cooldown because the row would not be eligible even if
   the cooldown disappeared.
3. **cooldownWait** — unclaimed row is the current durable lane head, its row
   deadline is due, and the app cooldown is active.
4. **ready** — unclaimed row is the current durable lane head, its row deadline
   is due, and no app cooldown is active.
5. **waitingBehindLane** — every other unclaimed pending row. This includes
   successors behind another pending revision and pending rows whose lane head is
   suppressed by an active quarantine.

The categories are mutually exclusive and exhaustive:

```text
ready + inFlight + retryWait + cooldownWait + waitingBehindLane = pendingOutbox
```

An active cooldown with no due lane heads produces `cooldownWait=0`. A row that
is both backed off and covered by a cooldown remains `retryWait`. An uncertain
effect is already a dead letter and is not counted in any pending class.

## Query and consistency

`SqliteOperationsStore.getOperationalSummary()` captures one `observedAt` and
uses it for every comparison and age calculation. The partition is computed in
one aggregate SQL query over pending replies with a left join to
`outbox_lane_heads` and one read of the app cooldown snapshot.

The query must not enumerate reply, lane, binding, prompt, Worker, or message
identifiers. It returns only counts and the minimum `claimed_at`. Existing
indexes on pending outbox state, lane heads, and claim identity remain the first
implementation; no new index is added without an explain-plan or measurement
showing a need.

`oldestInFlightAt` is the minimum non-null `claimed_at` among in-flight rows.
`oldestInFlightAgeSeconds` is the non-negative whole-second difference from
`observedAt`. Both are null when no claim is active. A malformed legacy timestamp
must not throw; it yields a null age while retaining the bounded timestamp value.

The summary is observational. It does not update rows, release claims, refresh
lane heads, or remove expired cooldown records.

## Relationship to existing diagnostics

- `pendingOutbox` remains the total number of pending rows.
- `outboxLanes` remains a lane-head-oriented compatibility view. It is not
  redefined or removed in this slice.
- `outboxDispatcher.activeDeliveries` remains the number of handlers running in
  the current process.
- `outboxWork.inFlight` is the number of durable claimed rows in SQLite.

The two in-flight counts are intentionally not asserted equal. A durable claim
can exist before a handler is visible in a sampled dispatcher snapshot, during
shutdown, or after owner loss until recovery settlement. Conversely, a handler
may have completed its external await and be between local operations when the
two snapshots are collected. Operators use the pair to diagnose drift; neither
repairs the other.

## Health policy

Normal `ready`, `inFlight`, `retryWait`, `cooldownWait`, and
`waitingBehindLane` counts do not independently degrade `/status`. Existing
signals retain responsibility:

- active app cooldown already degrades status;
- active quarantine and stalled due lane heads already degrade status;
- uncertain effects and recovery obligations retain their existing visibility;
- readiness remains dependency- and lease-oriented.

This slice deliberately does not label an old in-flight claim as stale. HTTP
timeout, shutdown, lease takeover, and owner-loss recovery already own that
lifecycle. A later design may introduce a threshold only with evidence that it
does not race legitimate long Lark requests.

## Tests

### SQLite partition

- An empty store reports all five counts as zero and both oldest fields null.
- Fixtures create one ready head, one claimed head, one backed-off head, one due
  head under app cooldown, and one successor; each enters exactly one class.
- The sum of the five classes equals `pendingOutbox`.
- Claim, retry settlement, delivery ACK, dead letter, quarantine release, and
  cooldown expiry move rows between classes without changing unrelated rows.
- A claimed row remains in-flight across reopen until existing owner-loss logic
  settles it; the test does not invent replay behavior.
- Oldest claim timestamp and age use one observation time and never go negative.

Because one global cooldown prevents a simultaneous ready class in the same
snapshot, ready/retry/in-flight/successor coverage and cooldown-wait coverage may
use separate fixtures. Each fixture still proves its own partition equality.

### Health and compatibility

- `/status` returns `outboxWork` without identifiers or payloads.
- A normal in-flight count does not degrade status or readiness.
- An active cooldown continues to degrade status through the existing cooldown
  signal, not because `cooldownWait` is nonzero.
- Existing `pendingOutbox`, `outboxLanes`, dispatcher diagnostics, and lifecycle
  safety-gate tests remain green.

Run focused SQLite and health tests, then `npm run typecheck`, `npm run build`,
`npm run architecture:check`, `npm test`, and `git diff --check`. Tests use only
temporary/in-memory SQLite and local health servers.

## Acceptance criteria

- Every pending outbox row belongs to exactly one `outboxWork` class.
- Durable in-flight work remains visible independently of dispatcher memory.
- Retry wait, cooldown wait, ready heads, and lane-serialized work are not
  conflated.
- No normal work class changes status or readiness by itself.
- Existing delivery, recovery, lease, cooldown, and no-replay protocols are
  unchanged.
- Diagnostics expose counts and bounded timestamps only, never durable IDs,
  payloads, prompts, actors, or credentials.
