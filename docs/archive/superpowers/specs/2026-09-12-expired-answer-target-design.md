# Expired Answer Target Design

## Goal

Stop startup convergence from repeatedly updating Feishu Answer messages that
the provider has definitively rejected as older than its update window. Preserve
the durable answer and all delivery evidence without delaying current live cards.

## Selected design

The Feishu Gateway maps provider code `230031` to a permanent, rejected failure.
For Primary Answer whole-card updates it also emits the provider-neutral recovery
kind `expired_view_target`. Core delivery policy never interprets the Feishu code.

When SQLite settles an `expired_view_target` failure for a replaceable Answer
projection, it:

- dead-letters the exact failed delivery once;
- dismisses unclaimed successors for the same projection key;
- records dismissed recovery evidence with action `expired_view_target`;
- releases the lane so unrelated work can continue.

Before reserving another Answer snapshot, the projection store checks for this
terminal evidence on the same projection key. If present, it returns `waiting`
without generating another revision. The key contains the prompt, page, and
physical message/card target, so an explicit rebuild onto a new target uses a new
key and can deliver normally.

## Legacy convergence

An idempotent Gateway migration converts existing Feishu `230031` Answer
`card_update` recovery rows with a non-null projection key to dismissed
`expired_view_target` evidence. It does not delete outbox history, alter Run Card
content, advance delivered versions, or infer success. Rows without a precise
projection key remain untouched.

## Invariants

- Provider codes remain inside the Feishu adapter and its compatibility migration.
- SQLite remains authoritative for durable projection and failure evidence.
- Claimed, attempted, checkpointed, or uncertain deliveries are never rewritten.
- No prompt or TraeX effect is replayed.
- Main Card, Worker Card, streaming Answer content, and create operations retain
  their existing recovery behavior.

## Tests

- `230031` is permanent on first rejection and maps to
  `expired_view_target` only for Primary Answer update operations.
- Exact expired projection evidence suppresses later revisions.
- A different message target remains eligible.
- Pending unclaimed successors are dismissed; claimed successors are preserved.
- The legacy migration is idempotent and converts only precise Feishu Answer
  projection rows.
