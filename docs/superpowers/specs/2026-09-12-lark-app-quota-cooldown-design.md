# Lark App Quota Cooldown Design

## Problem

The outbox currently applies HTTP 429 `Retry-After` only to the rejected reply.
Other independent lanes remain eligible and immediately call Lark under the same
application identity. If the upstream quota is shared, this amplifies the rate
limit, consumes retry budgets, and creates avoidable user-visible failures.

The configured service has one Lark application identity, while current 429
responses expose no trustworthy quota-scope identifier. Treating message,
CardKit, and topic operations as independent quota domains would therefore be an
unsupported assumption.

## Goals

- Persist one conservative application-wide Lark delivery cooldown after HTTP
  429.
- Settle the failed claim and extend the cooldown atomically.
- Prevent every new Lark outbox claim until the cooldown expires, including
  force scans and process restarts.
- Preserve unrelated inbound persistence, Herdr reconciliation, and
  Prompt/Worker workflows.
- Resume automatically at the durable deadline without rewriting every outbox
  row.
- Expose bounded cooldown diagnostics without payloads or credentials.

## Non-goals

- Inventing endpoint- or method-specific quota scopes.
- Cancelling Lark requests that were already in flight when a 429 arrives.
- Changing individual retry budgets or dead-letter policy.
- Changing readiness, Prompt replay, Worker scheduling, or Lark adapter APIs.
- Adding a distributed coordinator, Redis, or an external queue.
- Claiming a production latency SLA from local tests.

## Considered approaches

### 1. Durable app-wide cooldown (selected)

All outbound calls share the configured Lark app identity. A 429 extends one
SQLite cooldown row. Selection and claim both honor it. This may suppress an
endpoint whose quota is actually independent, but it prevents continued calls
against an unknown shared limit and remains correct across restart.

### 2. Operation-family cooldowns

Separate message, CardKit, and topic scopes would preserve more concurrency.
However, the current response does not prove those quota boundaries. If the
limit is app-wide, other families would continue causing 429 responses.

### 3. Keep row-only `Retry-After`

This needs no schema change but does not solve the cross-lane amplification. It
is retained only as the per-reply retry floor beneath the new global gate.

## Durable model

Add migration 38 and a latest-schema table with one supported scope:

```sql
CREATE TABLE lark_delivery_cooldowns(
  scope TEXT PRIMARY KEY CHECK(scope = 'app'),
  blocked_until TEXT NOT NULL,
  trigger_count INTEGER NOT NULL CHECK(trigger_count >= 1),
  last_http_status INTEGER,
  last_lark_error_code TEXT,
  last_reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The row is an operational checkpoint, not an event log. Expired rows remain as a
bounded audit summary and do not block delivery. `last_reason` uses the existing
500-character bounded, redacted failure text. No request payload, SDK response,
token, actor identity, or card content is stored.

The initial scope is always `app`. Future expansion requires trustworthy
upstream scope evidence, an explicit enum change, and new tests; the current
implementation must not derive scope from operation names.

## Deadline calculation

The classifier continues parsing `Retry-After` as seconds or an HTTP date. Its
result is clamped to at most one hour. The row-level retry time remains no earlier
than the existing exponential-backoff floor.

For a 429 with a valid header, the cooldown candidate is the same bounded delay
used for the failed row. For a missing or invalid header, the failure settlement
computes the existing jittered exponential delay once and uses the resulting
row retry deadline as the cooldown candidate. The store must not independently
sample a second random delay.

The upsert sets `blocked_until` to the later of the existing and candidate
deadlines. Concurrent or subsequent 429 responses can extend a cooldown but can
never shorten it. `trigger_count` increments for every successfully fenced 429
settlement.

## Atomic settlement

`markOutboundReplyFailedWithQuarantine` and the underlying delivery store retain
their existing transaction. For a classified HTTP 429, that transaction:

1. validates the exact claim attempt and lease fence;
2. updates the reply attempt, failure metadata, and `next_attempt_at`;
3. upserts the app cooldown using that exact persisted retry deadline;
4. releases the claim and refreshes lane state as currently required.

If claim validation fails or the transaction rolls back, neither the reply nor
the cooldown changes. A stale receipt cannot extend the cooldown. Non-429
failures never create or extend it.

Already in-flight sibling requests are not cancelled. Their results settle under
their own claims. A sibling 429 may extend the cooldown; success or another
failure may not clear or shorten it.

## Selection, claim, and wake-up

The cooldown is enforced at two durable seams:

- `listOutboundLaneHeads` returns no candidates while the app cooldown is
  active;
- `claimOutboundReply` independently rejects a claim while it is active, closing
  the selection-to-claim race.

`requestScan(true)` bypasses a reply's `next_attempt_at` only. It never bypasses
the app cooldown. This keeps startup convergence, recovery tooling, and internal
force scans from disabling rate-limit protection.

`getNextOutboundLaneHeadAttemptAt` computes the first useful wake-up as:

```text
max(minimum pending lane-head next_attempt_at, active app blocked_until)
```

If no pending lane head exists, it returns null even if an audit cooldown row is
present. No outbox row is bulk-updated when the cooldown starts or expires.

After the durable deadline, the dispatcher schedules one `0..250ms` local jitter
before its next scan. The jitter must not permit a call before `blocked_until`,
is not persisted, and does not change the server-provided minimum. Once scanning
resumes, the existing four-slot work-conserving pump and 3:1 live/history policy
apply. If multiple processes ever compete, the existing instance lease and claim
fence remain authoritative; this slice does not create a second ownership
mechanism.

## Diagnostics and health

Extend the operational summary with:

```ts
larkDeliveryCooldown: {
  active: boolean;
  blockedUntil: string | null;
  remainingMs: number;
  triggerCount: number;
  lastHttpStatus: number | null;
  lastLarkErrorCode: string | null;
};
```

Expired or absent state reports `active=false` and `remainingMs=0`; an expired
row may still expose its bounded audit fields. `/status` becomes degraded while
the cooldown is active because outbound progress is intentionally suspended.
`/ready` remains unchanged: the service can still durably accept work and its
dependencies remain usable.

Dispatcher diagnostics continue showing zero active delivery once existing
siblings settle. The cooldown summary explains why pending lane heads are not
eligible without exposing their identifiers or payloads.

## Failure boundaries

- HTTP 429 must carry a definite response and therefore remains
  `effectCertainty=rejected` and `failureClass=transient`.
- Timeout, reset, and unknown effects continue to use uncertain quarantine and
  do not start a quota cooldown merely because an error message mentions rate
  limiting.
- HTTP 5xx, DNS, connection refusal, and connect timeout keep their current
  row-level retry behavior.
- A malformed or negative `Retry-After` uses the existing fallback; a delay over
  one hour is clamped.
- Clock comparisons use UTC ISO timestamps generated by the service. The design
  assumes the same host clock used by the existing SQLite retry scheduler.
- Manual retry may reopen a row but cannot bypass an active app cooldown.

## Tests

### Classifier

- Parse seconds, HTTP dates, missing, malformed, negative, and over-one-hour
  `Retry-After` values.
- Preserve HTTP 429 as transient and rejected.
- Prove timeout or text-only rate-limit errors do not create 429 metadata.

### SQLite

- A matching 429 claim atomically updates the row and app cooldown.
- A stale claim changes neither row nor cooldown.
- A later deadline extends the cooldown; an earlier deadline only increments the
  trigger count and audit fields.
- Lane selection and direct claim return no work before expiry, including when
  row-level deadlines are already due.
- Selection and claim resume after expiry without deleting or rewriting rows.
- The next-wake query returns the later of lane due time and cooldown deadline.
- Closing and reopening the database preserves the gate.
- Migration 38 is additive, idempotent, and preserves existing outbox state.

### Dispatcher and health

- One lane receiving 429 prevents a second independent lane from calling Lark
  before expiry.
- `requestScan(true)` cannot bypass the cooldown.
- A restart during cooldown still suppresses calls and resumes after expiry.
- Multiple already in-flight 429 responses can only extend the deadline.
- After expiry plus bounded scheduling jitter, normal concurrency resumes.
- Non-Lark workflow state remains writable during cooldown.
- `/status` reports the bounded cooldown and degrades status while active;
  readiness is unchanged.

Run focused classifier, SQLite, dispatcher, and health tests; then run
`npm run typecheck`, `npm run build`, `npm run architecture:check`, `npm test`,
and `git diff --check`. Tests use fake Lark adapters, fake time, and temporary
SQLite only.

## Acceptance criteria

- No new Lark request starts while the durable app cooldown is active.
- A force scan, manual retry, or restart cannot bypass the gate.
- A stale claim cannot create or extend cooldown state.
- Multiple 429 responses never shorten the current deadline.
- Delivery resumes automatically after the durable boundary without bulk row
  mutation.
- Cooldown blocks only Lark outbox delivery, not durable inbound or Herdr work.
- Status exposes bounded reason and timing data; readiness and secret handling
  remain unchanged.
- No real Lark delivery, installation, restart, deployment, or push occurs in
  this slice.
