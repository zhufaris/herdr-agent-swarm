# Realtime Answer Batch Delivery Design

## Goal

Make a running Answer card feel live without turning every model delta into a Lark request. The first non-empty answer must be scheduled immediately. Later answer snapshots are coalesced for at most 500 ms, or flushed early after 80 new canonical characters. Terminal and blocked transitions remain immediate.

## Design

`ConversationViewProjector` remains the owner of render scheduling. It compares the canonical answer length after each `TurnOutputObserved` event with the length at the last successful convergence. A first non-empty answer, an 80-character increment, or a terminal transition requests an immediate scheduler flush. Smaller increments share one 500 ms timer. `CardUpdateScheduler` continues to serialize each prompt and collapses concurrent versions to the newest cumulative snapshot.

The Answer card remains a CardKit streaming card so `cardkit.v1.cardElement.content` can update the existing element. Native typewriter configuration is removed: each durable cumulative update is displayed as a small batch instead of replaying it character by character. The canonical RunCard answer, Answer page sequence, 9,000-character pagination, frozen-page rule, and outbox transaction boundaries are unchanged.

## Failure and Rate-Limit Behavior

The projector only reserves durable intent. Lark transport remains behind the existing per-lane outbox ordering, retry classification, exponential backoff, and dead-letter handling. A failed or rate-limited update is not bypassed by later updates. Content snapshots may coalesce, but prompt execution and canonical answer persistence do not depend on successful delivery.

## Verification

- The first non-empty answer schedules immediately even below 80 characters.
- A later increment below 80 characters waits for the 500 ms interval.
- An increment reaching 80 characters flushes immediately.
- Blocked, completed, and failed transitions flush immediately.
- Streaming Answer cards retain `streaming_mode` but omit native typewriter configuration.
- Existing ordering, retry, recovery, and continuation-page tests remain green.

