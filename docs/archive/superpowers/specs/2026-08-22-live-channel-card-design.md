# Live Channel Card Design

## Problem

The bridge continuously updates each request card, but prompt-scoped events return from `CardProjector` before updating the channel's primary status card. As a result, the primary `TraeX · project / pane` card remains stale while Herdr and the request card advance.

## Design

Each prompt lifecycle event is projected twice:

1. Reduce and schedule the prompt's request card exactly as today.
2. Reduce the same event into the binding's primary topic view and update its status card.

The primary card is a compact mirror of the active pane. `TurnOutputObserved` copies the current request card's accumulated answer into the topic view, while start, blocked, completion, failure, agent state, and queue events continue to use the topic reducer. The request card remains the complete per-request record.

To prevent an older request from overwriting a newer active request, terminal events only affect the primary card when no newer request is queued or running. Non-terminal observations belong to the currently executing prompt because the coordinator serializes prompt execution per binding.

Both projections use the existing durable SQLite outbox. Request-card coalescing remains unchanged; primary-card updates retain their event-id idempotency keys.

## Verification

An integration test creates both a primary card and a request card, publishes start and output events, and asserts that Lark receives updates for both message IDs and that the primary card contains the live answer. A second test covers the stale-completion guard for overlapping requests.
