# Main Card Lock Recovery and Random Tab Naming

## Goal

Recover project provisioning when Lark rejects a Main Card update with code
`230099` (`card action is lock`) while preserving the established Herdr
`task-xxxx` naming convention.

## Design

Lark code `230099` is target-specific: retrying an update against the same
locked Main Card cannot make provisioning converge reliably. When it occurs on
a `session_status` `card_update`, the store dead-letters that exact update,
keeps the existing `statusMessageId` until replacement delivery succeeds, and
enqueues one `card_reply` containing the newest durable TopicView snapshot.
Successful delivery uses the existing atomic checkpoint path to replace
`statusMessageId` and advance `deliveredVersion`. No TraeX prompt is replayed.

The behavior is intentionally limited to Main Cards. Other `230099` failures
retain their existing conservative classification and retry behavior. Existing
dead letters remain audit history and are not bulk replayed.

New and reset Herdr sessions always receive a generated `task-xxxx` pane title,
where `xxxx` is the existing four-character base36 random suffix. User prompt
text and `/swarm new` title text remain available for the Lark-facing binding
title but are never passed as the Herdr pane or tab title. Explicit rename
commands remain unchanged.

## Verification

- A locked Main Card update creates and delivers exactly one replacement card.
- The old Main Card pointer remains until replacement delivery succeeds.
- A newer queued snapshot becomes the replacement payload.
- Natural-language and titled `/swarm new` flows create `task-xxxx` tabs.
- Focused tests, typecheck, build, and the full Vitest suite pass.
