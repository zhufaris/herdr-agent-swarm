# Model Command Card Delivery

## Status

Approved design. This document fixes the Lark delivery path for the Primary
`/swarm model` command without changing TraeX model-selection semantics.

## Problem

`/swarm model` is received as an ordinary Lark text message. The model
workflow currently sends its catalog, selection result, unavailable notice, and
catalog-read failure using a CardKit update addressed to that text message ID.
Lark rejects the update because a text message cannot be updated as a card:
`230001: This message is NOT a card`. The command is accepted, but the user
does not receive the model-selection UI or confirmation.

## Decision

The first response to every text-originated `/swarm model` command is a newly
created CardKit reply. That reply contains the structured model catalog or the
result state. It is independent of the triggering text-message ID.

Once the user selects a model from that CardKit reply, the existing card-action
path updates the card that supplied the action. This preserves the normal
selection interaction while ensuring that `updateCard` only targets a CardKit
message.

## Behavior

| Input | Delivery | Result |
| --- | --- | --- |
| `/swarm model` text command | Create reply card | Native-session catalog and selectable models |
| `/swarm model <name>` text command | Create reply card | Selection confirmation or deterministic validation notice |
| Model-card selection action | Update source model card | Updated selection confirmation and current catalog state |
| Inactive or unsupported session | Create reply card for text; update source card for action | Existing unavailable/rejection message |
| Catalog read failure | Create reply card for text; update source card for action | Existing sanitized failure message |

The selection remains pending until the next ordinary FIFO prompt claims it. It
does not interrupt an active turn, send terminal `/model` input, or create a
prompt by itself. The claimed prompt is still sent through the existing native
TraeX `turn/start` prepare/commit protocol with the selected model.

## Implementation boundary

`ModelSelectionWorkflow` receives the reply target as part of its existing
text-message or card-action entry point. A small internal delivery helper
chooses `enqueueCard` for text-originated commands and `enqueueCardUpdate` for
CardKit actions. Rendering, model-catalog validation, preference persistence,
outbox idempotency, and prompt dispatch remain unchanged.

The helper must assign a stable idempotency key for each delivery class so a
replayed inbound message cannot create duplicate result cards. Card-action
updates retain their source-card message ID and current update idempotency
shape.

## Error handling and durability

The result card is persisted through the durable outbox before Lark delivery. A
delivery retry may retry only the card operation; it never repeats model
selection or a future TraeX turn. No attempt is made to transform or update the
original text message.

## Tests

`tests/model-command-integration.test.ts` will assert that a text `/swarm model`
command creates a card and does not request a card update for its text message
ID. It will retain the card-action test that verifies an existing model card is
updated after selection. Focused tests will cover explicit model selection and
the catalog list path as applicable. Type checking and the production build are
required before handoff.
