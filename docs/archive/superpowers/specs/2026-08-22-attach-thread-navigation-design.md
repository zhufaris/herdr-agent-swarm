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
`打开项目话题` button when the binding has a root message ID. The button sends
an `open_project_thread` callback to the bridge. The bridge validates that the
binding belongs to the requesting group, resolves legacy `om_...` roots to a
real `omt_...` thread ID when needed, and uses Feishu's public thread-forward
API to send a native, clickable topic card into that group. If a legacy or
partially recovered binding lacks both topic and root IDs, the result still
reports success but omits the button.

The earlier implementation used `/client/chat/open?openChatId=...&openMessageId=...`.
That assumption was incorrect: the documented chat AppLink does not support
`openMessageId`, and Feishu's copy-message link requires a private token that
cannot be derived from an Open API message ID.

Bindings owned by another group remain rejected. Their topic metadata and link
are never included in the response. Unknown, ambiguous, ineligible, and
otherwise invalid pane references continue to use the existing rejection card.

## Alternatives considered

Reusing the generic rejection card would minimize code changes, but would keep
rendering a healthy idempotent result as `请求未执行` and has no navigation
contract. Updating the project-selection card for attach would reuse its button,
but its `项目已打开` language and selection-specific states do not model an
attach command cleanly. A dedicated attach status card keeps the success
semantics explicit while both cards share the same callback action.

## Data flow

For an already attached pane, the coordinator resolves the current-group
binding and replies to the attach command with the success card. It creates no
topic or binding. Clicking the action validates the binding's chat ownership
before forwarding its topic.

For a newly attached pane, normal attachment and topic creation finish first.
The coordinator then reloads the binding and replies with the success card.
Topic creation remains the source of truth; the result card is not sent before
activation succeeds. New topic creation preserves `thread_id` when Feishu
returns it; legacy message IDs are resolved lazily on click.

## Verification

Command-entry integration tests assert that both first-time and idempotent
attach responses contain an `打开项目话题` callback and never contain the
unsupported `openMessageId` URL. The idempotent test continues to assert that
no second topic, binding, pane mutation, TraeX start, or prompt submission
occurs. Adapter tests cover both direct `omt_...` forwarding and legacy root
resolution. Cross-group rejection tests assert that no topic identity is
exposed. A card unit test covers the no-root-message fallback without a button.
