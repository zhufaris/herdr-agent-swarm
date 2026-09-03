# Atomic Continuation Queue Capacity Design

## Status

Approved for implementation. The user authorized the recommended approach to
proceed without per-batch confirmation.

## Problem

`InboundRouter` checks queue capacity before classifying ordinary work, but an
eligible continuation bypasses that check because it may become automatic
steering. The SQLite acceptance transaction then revalidates the candidate
parent. If that parent becomes invalid before acceptance, the message falls
back to an ordinary prompt without rechecking capacity and can exceed
`MAX_QUEUE_DEPTH`.

The final dispatch kind and the capacity decision must be made against the same
SQLite snapshot. A rejected message must not create a prompt, Run Card, Answer
Card outbox row, scheduler wake-up, lifecycle event, or success audit record.

## Goals

1. Enforce ordinary prompt capacity inside the classified-prompt acceptance
   transaction after the final dispatch kind is selected.
2. Continue accepting valid automatic steering while the ordinary queue is
   full.
3. Represent queue saturation as a normal business result instead of an
   exception.
4. Give the Lark user the existing queue-full feedback without logging a system
   failure.
5. Preserve duplicate-delivery idempotency and all existing FIFO, no-replay,
   outbox, and CardKit invariants.

## Selected design

`ClassifiedPromptInput` gains `maxQueueDepth`.
`ClassifiedPromptAcceptance` becomes a discriminated union:

- accepted results retain `prompt`, `view`, `inserted`, the dispatch decision,
  and the fallback reason;
- a rejected result has `decision: "queue_full"`, `inserted: false`, and the
  fallback reason that caused an eligible continuation to become ordinary. It
  has no `prompt` or `view`, because no durable prompt aggregate exists.

Inside one `BEGIN IMMEDIATE` transaction, the store first checks for an existing
message to preserve idempotency, then revalidates the binding and candidate
parent. When the final decision is ordinary, it counts pending prompts using the
existing queue-depth definition (`queued` plus `running`). If that count is at
least `maxQueueDepth`, it commits the read-only decision and returns
`queue_full` before inserting any prompt, view, answer page, or outbox intent.
Automatic steering skips the ordinary-capacity gate.

The router keeps its current precheck as a fast path for unambiguously ordinary
messages. It also handles the transactional `queue_full` result by sending the
same user-facing rejection and returning without any wake-up, lifecycle event,
or success audit. The rejection is expected control flow and is not emitted as
`lark-message-handling-failed`.

## Alternatives rejected

- Recheck capacity in the router after classification: the parent can still
  change between that check and the store transaction.
- Throw a queue-full exception from the store: this conflates expected user
  backpressure with infrastructure failure and triggers error logging.
- Reserve a queue slot before parent validation: this complicates idempotency
  and can incorrectly block valid automatic steering.

## Tests and acceptance

- Store: a full queue plus an invalidated parent returns `queue_full` and creates
  no prompt, Run Card, or outbound reply.
- Store: valid automatic steering remains accepted when the ordinary queue is
  full.
- Router: the race produces one queue-full user response, no scheduler wake, no
  lifecycle event, no success audit, and no system-error log.
- Router: ambiguous ordinary work retains its fast-path queue-full behavior.
- Duplicate delivery of an already accepted message still returns the original
  accepted result even if the queue is now full.
- Focused tests, typecheck, build, and the full Vitest suite pass.

## Non-goals

- Changing the configured queue depth or how running prompts are counted.
- Applying this capacity policy to explicit `/swarm steer`.
- Refactoring the prompt scheduler or changing Lark card rendering.
- Deploying while unrelated uncommitted runtime source would be included in the
  build.
