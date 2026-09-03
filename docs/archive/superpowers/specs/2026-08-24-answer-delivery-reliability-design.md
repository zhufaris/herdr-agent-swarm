# Answer Delivery Reliability Design

## Scope

This change completes the remaining reliability work identified after the
Answer Card `element_id` repair. It covers only the durable Answer delivery
path: outbox ordering, streaming-card creation recovery, Lark request bounds,
legacy target convergence, and removal of the obsolete renderer-side ID
fallback. It does not change prompt dispatch, Herdr observation, user commands,
or service lifecycle.

## Goals

- Preserve strict durable ordering for all operations belonging to one Answer
  stream, including while the lane head is waiting for retry.
- Avoid duplicate visible Answer messages after ambiguous Lark failures and
  reuse a previously persisted CardKit entity when message delivery is retried.
- Bound Lark request duration, cross-target concurrency, and outbox reads.
- Wake retries near their persisted `next_attempt_at` instead of depending on
  unrelated reconciliation activity.
- Run legacy Answer-ID convergence once, repair payload-only divergence, and
  avoid unconditional schema churn on later database opens.
- Keep the domain run-card value as the single source of truth for the active
  Answer element ID.

## Non-goals

- Exactly-once CardKit entity creation. The installed CardKit create API has no
  idempotency key. A crash after remote entity creation but before receiving its
  ID can still leave an unreferenced entity. The design guarantees that a known,
  persisted entity is reused and that message reply uses provider idempotency.
- General pagination fixes for project, operations, or space-directory cards.
- Build-system tuning such as declaration emit or incremental compilation.
- Introducing a general job queue or a separate `answer_pages` table.

## Durable Answer lanes

All Answer outbox rows for one prompt share the lane key `answer:<promptId>`.
Non-Answer work retains its current message/card target key. Ordering is based
on an immutable insertion ordinal stored in SQLite; timestamps are not treated
as a total ordering mechanism.

The store exposes only eligible lane heads. A lane head waiting until a future
`next_attempt_at` blocks every later row in that lane. The publisher processes a
bounded number of distinct lane heads concurrently. A failed `stream_content`
therefore blocks its `stream_finish`, and a failed finish blocks continuation
creation across drain invocations and process restarts.

The default delivery concurrency is four. This is an internal constant for this
change rather than a new operator setting. The store limits each fetch and the
publisher refills workers until no eligible heads remain.

## Retry scheduling and request deadlines

After every enqueue, success, or failure, the publisher examines the earliest
pending lane head. If it is not yet due, it owns one unreferenced timer for that
timestamp. Replacing or stopping the publisher cancels the timer. Forced retry
continues to bypass time eligibility for explicit operator recovery, but never
bypasses lane ordering.

All Lark REST operations receive a bounded timeout through the adapter's HTTP
transport. Timeout failures remain transient and use exponential backoff with
jitter. HTTP 429 honors `Retry-After` when the SDK response exposes it. Shutdown
waits only for bounded calls and can therefore complete predictably.

## Recoverable streaming-card creation

`stream_card_create` becomes a two-stage durable operation:

1. Validate the Answer lane target.
2. If the outbox row has no persisted CardKit ID, create the CardKit entity and
   atomically checkpoint its `card_id` on that row.
3. Reply with the persisted card reference, passing a stable UUID derived from
   the outbox idempotency key.
4. Atomically mark the row delivered and advance the run-card active page using
   the existing page-index compare-and-set predicate.

Retries always resume from the checkpoint. Ordinary text/card replies also pass
their stable outbox key to Lark's supported `uuid` field. A checkpointed row
remains pending until the message reference is delivered; it is not considered
visible merely because the entity exists.

The Lark port is split into explicit `createStreamingCard` and
`replyStreamingCardReference` operations so persistence occurs at the actual
durability boundary instead of being hidden inside one adapter call.

## Target validation

Continuation creation validates all of the following before transport:

- binding and prompt ownership;
- topic root message;
- expected next page index;
- monotonic page start;
- `stream.elementId === answerElementId(promptId, pageIndex)`;
- every streaming `element_id` in the card payload matches the same ID.

Malformed payloads and durable target mismatches are permanent failures and go
directly to dead letter. Transport timeouts, 429s, and server failures remain
retryable.

## Migration and schema convergence

A new versioned migration performs Answer target convergence exactly once. For
each Answer outbox row in `pending` or `dead_letter`, the persisted run-card ID
is authoritative. The migration rewrites card JSON, continuation metadata, and
stream-content metadata to that value even when the run-card ID was already
canonical. It then requeues only the existing narrow class of queued initial
Answer creates rejected by the historical element-ID format.

The migration uses bounded batches and a prompt-oriented outbox index. Once its
version is recorded, later opens do not rescan historical cards. Schema helpers
rebuild `run_cards_view` only when its underlying columns actually change, so a
no-op reopen leaves `PRAGMA schema_version` unchanged.

## Code cleanup

`RunCardView.answerElementId` remains required. `renderRequestAnswerCard` uses it
directly. The renderer-local fallback generator is deleted, leaving the domain
`answerElementId(promptId, pageIndex)` as the sole generator. Adapter-level
normalization remains as defensive validation at the external boundary.

## Test design

### Publisher ordering

- A failed content row blocks finish until retry succeeds.
- Failed content and failed finish both block continuation creation.
- Ordering survives a store close/reopen.
- Sequence numbers observed by the fake Lark adapter are strictly increasing.
- Many independent targets never exceed four concurrent calls and still drain.

### External idempotency

- Entity creation succeeds and message reply fails: retry reuses the checkpointed
  card ID and stable reply UUID.
- Message reply is remotely accepted but locally times out: retry uses the same
  UUID and produces one logical message.
- The stored message/card pair always corresponds to the referenced entity.
- A never-resolving request reaches the configured deadline, schedules retry,
  and does not prevent publisher shutdown.

### Target validation

- Reject a continuation whose derived ID, stream metadata ID, and card element
  ID differ.
- Reject a non-monotonic page start or unexpected page index without calling
  Lark and without repeated retries.

### Migration

- Repair payload-only divergence when the run-card ID is already canonical.
- Repair multiple prompts and payload kinds while leaving unrelated rows byte
  identical.
- Reopen a migrated database twice and confirm no repeated data scan or schema
  version change.
- Confirm the prompt-oriented migration query uses its index.
- Preserve the existing selective legacy dead-letter recovery behavior.

### Regression gates

- Run focused publisher, adapter, store, run-card, and event-card integration
  tests.
- Run the complete Vitest suite, TypeScript typecheck, production build, and
  `git diff --check`.

## Delivery plan

Implementation is split into independently reviewable commits:

1. Durable lane-head ordering, bounded concurrency, retry wake-up, and timeout.
2. Two-stage streaming-card creation and provider message idempotency.
3. Versioned Answer-ID migration, schema no-op behavior, and renderer cleanup.

No service restart or push is part of this work.
