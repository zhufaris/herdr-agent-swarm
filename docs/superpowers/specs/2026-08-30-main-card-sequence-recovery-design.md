# Main Card Sequence Recovery Design

## Goal

Keep a topic Main Card convergent when Lark CardKit rejects a full-card update
with business code `300317` (`sequence number compare failed`).

## Context

Main Card delivery uses the durable `TopicViewState.viewVersion` as the CardKit
update sequence. The outbox records intent before delivery and advances
`deliveredVersion` only after Lark confirms success. A process can therefore be
stopped after Lark accepts an update but before SQLite records the checkpoint.
After restart, replaying the durable update uses a sequence that Lark has
already passed and every retry is rejected with `300317`. Lark does not expose
the accepted sequence through the update or ID-conversion response.

## Design

Treat `300317` on a Main Card full update as an unrecoverable property of that
card entity, not as a transient transport error. Reuse the existing Main Card
replacement transaction used for locked cards (`230099`):

1. Dead-letter the rejected update immediately.
2. Select the newest desired Main Card payload for the binding.
3. Remove superseded pending updates for the old card entity.
4. Enqueue one idempotent `card_reply` against the binding root message.
5. Release the old Main Card lane.
6. When Lark confirms the reply, atomically replace the binding's
   `statusMessageId` and advance the topic view's delivered checkpoint.

The new message converts to a fresh CardKit entity on its first later update,
so CardKit sequence ordering restarts without guessing remote state. Existing
outbox idempotency prevents duplicate replacement messages across retries.

## Boundaries

- Apply this recovery only to `card_update` replies whose target role is
  `session_status`.
- Preserve the existing `230099` replacement behavior.
- Do not classify `300317` as globally permanent; Answer Card sequencing has a
  different recovery boundary.
- Do not modify transcript observation, prompt replay, or Answer stream state.
- Do not infer durable state from the visible Lark card.

## Verification

- An outbox dispatcher regression test must simulate an HTTP-success CardKit
  response carrying `300317` and prove that the old update is dead-lettered, a
  replacement `card_reply` is delivered, and the binding points to the new
  message.
- Existing `230099` replacement coverage must remain green.
- Run focused adapter, dispatcher, and SQLite tests, then typecheck, build, and
  the full suite.
- Install an immutable committed release, restart only through the supported
  lifecycle, and verify a real post-restart Main Card update is delivered with
  observed and expected build identities matching.
