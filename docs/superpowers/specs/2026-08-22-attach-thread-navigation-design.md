# Attach Thread Navigation Design

## Goal

Let a user jump directly from an `/herdr attach` result to the Feishu topic
already associated with the resolved Herdr pane.

## Chosen interaction

The bridge sends a dedicated successful attach result card for both successful
outcomes:

- a newly attached pane; and
- an idempotent request for a pane already attached to the configured group.

The card identifies the Space and stable pane ID and includes an
`打开项目话题` button when the binding has a root message ID. The button uses
the existing Feishu topic deep-link format already used by project-selection
completion cards. If a legacy or partially recovered binding lacks a root
message ID, the card still reports success but omits the button.

Bindings owned by another group remain rejected. Their topic metadata and link
are never included in the response. Unknown, ambiguous, ineligible, and
otherwise invalid pane references continue to use the existing rejection card.

## Alternatives considered

Reusing the generic rejection card would minimize code changes, but would keep
rendering a healthy idempotent result as `请求未执行` and has no navigation
contract. Updating the project-selection card for attach would reuse its button,
but its `项目已打开` language and selection-specific states do not model an
attach command cleanly. A dedicated attach status card keeps the success
semantics explicit while sharing only the existing URL builder.

## Data flow

For an already attached pane, the coordinator resolves the current-group
binding, builds the topic URL from `chatId` and `rootMessageId`, and replies to
the attach command with the success card. It creates no topic or binding.

For a newly attached pane, normal attachment and topic creation finish first.
The coordinator then reloads the binding, builds the same URL, and replies with
the success card. Topic creation remains the source of truth; the result card is
not sent before activation succeeds.

## Verification

Command-entry integration tests assert that both first-time and idempotent
attach responses contain `打开项目话题` and the expected encoded
`openMessageId`. The idempotent test continues to assert that no second topic,
binding, pane mutation, TraeX start, or prompt submission occurs. Cross-group
rejection tests assert that no topic link is exposed. A card unit test covers
the no-root-message fallback without a button.
