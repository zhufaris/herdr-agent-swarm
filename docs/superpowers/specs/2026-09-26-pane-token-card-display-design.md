# Native Herdr Pane Token Card Display

## Goal

Every user-visible Lark card displays the native four-character Herdr pane
token when Herdr supplies one. For example, a pane whose durable Herdr identity
is `wN:p4D` and whose native token is `vdfn` is shown as `vdfn`.

The full pane ID remains the authoritative machine identity. Prompt dispatch,
runtime fencing, reconciliation, callback payloads, pane operations, logs, and
database joins continue to use `paneId`. When no valid native token is
available, card presentation falls back to `paneId`.

## Current Problem

Herdr 0.9 includes `token` in pane records returned by `pane current`, pane
queries, and `session.snapshot`. The Swarm adapter accepts unknown fields but
does not declare or map `token`. `HerdrPane`, bindings, Worker runtime records,
and card views therefore retain only `paneId`. Every downstream renderer is
forced to show the full ID even when Herdr has already provided the preferred
human-facing token.

This display issue is independent of Answer acquisition. Herdr provides the
native Agent session identity and lifecycle state; the Swarm reads the Agent's
typed transcript, fences observations to the exact turn, persists card views
and outbox intent, and then renders CardKit payloads. Terminal screen scraping
is not an Answer source.

## Design

### Identity model

Add an optional `paneToken` alongside every persisted or projected pane
identity needed for presentation:

- `HerdrPane` carries the token parsed at the adapter boundary.
- Primary bindings persist the current pane token.
- Worker runtime references persist their current pane token.
- Primary Topic and Run Card views carry the token used for presentation.
- Worker Main and Turn views, pane directories, instance views, and operational
  card inputs carry the token where they display a pane reference.

`paneId` and `paneToken` are not interchangeable. `paneId` remains the identity
and fencing key; `paneToken` is display metadata only.

### Boundary validation

The Herdr adapter declares `token` as a nullable or optional string on pane and
snapshot schemas. It normalizes a token only when it matches the native
four-character lowercase alphanumeric form. Invalid or missing values become
`null` and use the normal fallback behavior.

The Swarm does not derive a token from a label, tab title, pane ID, hash, or the
existing Primary title token. Those values can differ from Herdr's native pane
token and are not substitutes for it.

### Durable propagation and convergence

SQLite migrations add nullable pane-token columns to Primary bindings and
Worker runtime identity storage. Existing databases remain valid and initially
contain `NULL` for those columns.

Provisioning, attachment, runtime adoption, and reconciliation persist the
native token together with the matching pane identity. A token update is
accepted only while the pane ID and generation fences still match. Normal
startup and periodic Herdr reconciliation backfill tokens for existing active
Primary and Worker panes.

Current mutable projections are rebuilt when a newly observed token changes
their visible identity. This refreshes Main Cards, active Answer cards, Worker
cards, and directory views through their existing durable projection and
outbox paths. Delivery remains idempotent and never repeats an Agent prompt.

Completed frozen Answer pages remain immutable. Historical frozen cards are not
patched solely to replace a pane ID with a token; all newly created cards and
all still-mutable cards use the token after it is known.

### Presentation rule

Introduce one pure shared formatter with the following contract:

```text
displayPaneIdentity({ paneToken, paneId })
  = valid paneToken, when present
  = paneId, otherwise
  = provisioning/unbound placeholder only when neither exists
```

All user-visible CardKit text routes pane identity through this formatter. The
coverage includes:

- Primary Main, pane-entry, request, streaming Answer, and final Answer cards;
- Worker Main, Worker Turn, Worker thread-entry, review, and instance cards;
- Space and topic pane directories;
- model, operation, close/retention, attach, failure, and status cards;
- any other card text that identifies a concrete Herdr pane.

Machine-facing values are unchanged. Callback payloads, form values that target
a pane, command inputs, idempotency keys, and ownership checks continue to carry
the complete `paneId` even when visible button or context text shows the token.
Structured logs continue to record the full pane ID and may include the token as
additional non-authoritative context.

## Failure and Compatibility Behavior

- Older Herdr versions or compatibility responses without `token` display the
  full pane ID.
- A malformed token is ignored rather than propagated to a card.
- A transient Herdr failure preserves the last persisted valid token; it does
  not clear display metadata based on absence of a fresh observation.
- Replacing, moving, closing, or reattaching a pane updates or clears its token
  under the same generation and pane-identity fences as the runtime reference.
- Outbox retries deliver the already persisted card payload and never perform a
  render-time Herdr lookup.

## Testing

Focused tests will establish:

1. The Herdr adapter parses native tokens from snapshots and compatibility pane
   responses, while missing or invalid tokens normalize to `null`.
2. SQLite migrations preserve old rows and round-trip Primary and Worker pane
   tokens.
3. Provisioning and reconciliation persist or refresh a token only under the
   matching pane and generation fence.
4. Shared presentation tests enumerate every pane-bearing card and verify token
   preference plus pane-ID fallback.
5. Callback and operation tests verify that visible text uses the token while
   action payloads and commands retain the full pane ID.
6. Projection integration tests verify that token backfill emits card delivery
   intent without dispatching or replaying a prompt.
7. Frozen Answer-page tests verify that historical pages remain unchanged.

Before handoff, run the focused adapter, store, reconciliation, Primary card,
Worker card, directory, and interaction tests, followed by `npm run typecheck`,
`npm run build`, and the full `npm test` suite because the change spans adapter,
persistence, projection, and presentation boundaries.
