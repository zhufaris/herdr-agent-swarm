# Ticket: Durable Main Card Delivery State

## Status

Approved for implementation on 2026-08-26.

## Problem

The binding-level Main Card is rendered from durable `topic_views`, but its
delivery version currently lives only in `ConversationViewProjector` memory. A
restart can lose scheduled work, startup emits unconditional updates, and Lark
delivery checkpoints do not record which durable view version is visible.

## Outcome

Persist Main Card desired and delivered versions, atomically save each changed
TopicView with its delivery intent, and use one idempotent convergence workflow
for live projection, delivery checkpoints, and startup recovery.

- Design: [Durable Main Card Delivery State](../specs/2026-08-26-main-card-delivery-state-design.md)
- Plan: [Durable Main Card Delivery State Implementation Plan](../plans/2026-08-26-main-card-delivery-state.md)

## Acceptance Criteria

1. `topic_views` is authoritative for Main Card content and desired/delivered versions.
2. A changed TopicView and its Main Card outbox intent commit atomically.
3. Initial-card creation remains unique while changes during creation are recovered as a later update.
4. Delivery checkpoints advance `deliveredVersion` monotonically and trigger convergence.
5. Live, startup, and checkpoint paths share one `MainCardWorkflow`.
6. Repeated or concurrent convergence creates no duplicate logical delivery.
7. Existing outbox retry, lane ordering, Answer Page, FIFO, and no-replay behavior remains unchanged.
8. Existing worktree identity and passive terminal projection changes are preserved.

## Out of Scope

- Main Card visual redesign.
- Answer Page pagination or CardKit stream settings.
- Prompt dispatch, steering, or Herdr observation semantics.
