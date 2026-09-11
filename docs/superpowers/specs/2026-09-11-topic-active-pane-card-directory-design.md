# Topic Active-Pane Card Directory Design

## Goal

Allow a user to list the active Primary panes available in the current Lark
chat and send any selected pane's latest Primary Main Card into the current
topic.

## Scope

- Add the read-only `/swarm panes` command.
- List only bindings in the current chat that are `active`, `attached`, have a
  pane ID, and retain a current Main Card projection. In a bound topic, limit
  the list to that topic's configured Herdr Space (same workspace and
  `spaceName`); an unbound group entry remains chat-wide.
- Render title, space, pane, and observed agent state, with a `发送卡片` button.
- On button callback, reload the binding and its topic view, re-check chat,
  generation, active/attached lifecycle, pane identity, and source Main Card
  identity.
- Reserve a new ordinary CardKit reply through the durable outbox, targeted at
  the callback's current topic/message.

## Non-goals

- Opening or forwarding another Lark topic.
- Updating, moving, or mutating the selected pane's existing Main Card.
- Showing archived, orphaned, detached, unbound, or cross-chat panes.
- Sending prompts or terminal input to Herdr or TraeX.

## Flow

`/swarm panes` is a global query, so it works from any topic in the configured
chat. The operations-query workflow reads durable bindings and Main Card views,
then emits a directory card through the existing outbox. Each action contains a
binding ID, generation, pane ID, and current Main Card message ID.

The callback is a dedicated `pane_card_send` action. It fails closed when any
identity check changes. On success it renders the current `TopicViewState` and
enqueues it as an immutable, idempotently keyed card reply beneath the callback
message. This makes delivery retryable without re-running a TraeX task.

## Verification

- Command parsing and policy classification.
- Directory filtering and card payload rendering.
- Callback acceptance only for an active, attached, same-chat, identity-matched
  binding, with a durable outbox reply reservation.
- Rejection of stale, cross-chat, changed-generation, detached, or source-card
  mismatches.
