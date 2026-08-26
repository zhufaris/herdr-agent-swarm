# Durable Main Card Delivery State

**Ticket:** [Durable Main Card Delivery State](../tickets/2026-08-26-main-card-delivery-state.md)

## Purpose

Make Main Card delivery recoverable and idempotent. SQLite owns the desired
TopicView and its delivery progress; Lark remains only the visible projection.

## State and authority

`TopicViewState` gains `viewVersion` and `deliveredVersion`. A visible reducer
transition increments `viewVersion`; a successful Main Card delivery advances
`deliveredVersion` with `MAX`, never by assignment. Existing JSON rows load with
both values defaulted to zero.

The binding's `statusMessageId` remains the durable Lark identity. A missing ID
means the workflow must create exactly one session-status reply. Once its
checkpoint is stored, later versions use message updates.

## Workflow and transaction boundary

`MainCardWorkflow.converge(bindingId)` serializes work per binding, loads the
binding and TopicView, renders the card, and asks the store to reserve delivery.
The store returns `reserved`, `waiting`, or `current`.

For live events, `projectMainCard(view, rootMessageId, card)` atomically upserts
the TopicView and reserves the corresponding outbox row. If the initial reply is
already pending, its immutable payload is not rewritten; after that reply is
delivered, the checkpoint wakes convergence and a normal update carries the
newest version. For an existing Main Card, version-specific update idempotency
keys and existing lane coalescing retain ordering while bounding obsolete work.

Outbox rows carry `bindingId`, `targetRole=session_status`, and `viewVersion`.
On successful delivery SQLite atomically marks the row delivered, checkpoints
`statusMessageId` for creation, and monotonically advances the TopicView's
`deliveredVersion`. The dispatcher then emits a Main Card checkpoint hint.

## Recovery

Startup repairs binding identity fields in TopicView, mirrors the latest RunCard
when appropriate, and calls the same workflow. It does not generate timestamp-
based unconditional update keys. If `viewVersion > deliveredVersion`, missing
intent is recreated; otherwise startup is a no-op. Duplicate or lost wake-ups are
safe because every pass reloads SQLite state.

Legacy TopicViews are normalized on read. Their first meaningful reconciliation
sets a durable desired version and emits one delivery; no schema rewrite of the
JSON table is required. Existing pending Main Card rows are respected.

## Boundaries

This change does not alter Main Card layout, Answer Page state, CardKit typewriter
parameters, prompt execution, or Herdr authority. Current worktree-name display
and passive-terminal projection changes remain valid inputs to TopicView.

## Verification

Tests cover atomic rollback, unique creation, monotonic checkpoints, concurrent
convergence, startup no-op/current behavior, startup recovery, and unchanged
Answer Page delivery. Full tests, typecheck, clean commit build, plugin restart,
identity/readiness checks, and production database invariants gate rollout.
