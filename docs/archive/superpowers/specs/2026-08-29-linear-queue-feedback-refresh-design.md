# Linear Queue Feedback Refresh Design

## Status

Approved for implementation. The user authorized the recommended approach to
proceed without per-batch confirmation.

## Problem

When an ordinary prompt leaves the queue, `PromptRunWorkflow` publishes one
`RunQueuePositionChanged` event for every queued card whose position changed.
`QueueFeedbackProjector` currently reacts to each of those per-prompt events by
loading and traversing the complete binding queue. Moving `q` prompts therefore
causes `q` full refreshes and O(q²) queue work.

The same lifecycle transition already publishes a binding-scoped trigger such
as `TurnStarted`, `TurnCompleted`, `TurnFailed`, or `PromptCancelled`. Queue
feedback computes positions from durable FIFO order and does not need each
per-card position event as another refresh trigger.

## Goals

1. Perform at most one complete queue-feedback refresh for a lifecycle change
   that also emits multiple position events.
2. Preserve per-card `RunQueuePositionChanged` projection into Run Cards.
3. Preserve periodic elapsed-time refresh, startup convergence, wait estimates,
   and outbox wake behavior.
4. Avoid a new lifecycle event or persistence migration.

## Selected design

Remove `RunQueuePositionChanged` from `QueueFeedbackProjector`'s refresh trigger
set. The event remains consumed by `ConversationViewProjector`, which updates
the affected Run Card's visible queue position. Queue feedback remains triggered
once at the binding level by the surrounding lifecycle event and derives
`aheadCount` from the durable FIFO ordering returned by
`loadQueueFeedbackInputs`, not from the old `queuePosition` field.

This is intentionally smaller than adding a new batch event: the necessary
binding-level invalidation already exists at every call site that invokes
`refreshQueuePositions`.

## Alternatives rejected

- Add `QueuePositionsChanged`: duplicates existing lifecycle triggers and expands
  the event contract without adding information needed by feedback projection.
- Debounce all projector refreshes: adds timing and shutdown complexity and can
  delay status/estimate changes; it also masks rather than removes redundant
  triggers.
- Batch queue positions and feedback in one SQLite transaction: potentially
  valuable later, but much larger than necessary for removing the confirmed
  quadratic behavior.

## Tests and acceptance

- Publishing `RunQueuePositionChanged` alone does not load queue-feedback inputs
  or reserve feedback outbox work.
- Each binding-level lifecycle event still triggers feedback convergence.
- Existing periodic and startup convergence behavior remains unchanged.
- Focused tests, typecheck, build, and the full Vitest suite pass.

## Non-goals

- Removing or batching Run Card queue-position events.
- Changing queue wait estimation.
- Refactoring SQLite projection transactions.
- Deploying while unrelated uncommitted runtime source would be included in the
  build.
