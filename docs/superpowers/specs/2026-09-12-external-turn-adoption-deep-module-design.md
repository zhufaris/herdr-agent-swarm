# External Turn Adoption Deep Module Design

## Goal

Move externally originated Primary Herdr turn adoption out of the broad
`SqlitePromptStore` into one deep SQLite module without changing observation,
supersession, no-replay, or Card delivery behavior.

## Problem

`adoptExternalTurn` is not a Prompt-row update. It is a complete convergence
decision that currently embeds all of these rules in the general prompt store:

- fence the exact active Binding generation, pane, and native Agent session;
- reject a runtime turn already owned by another Prompt;
- allow only identityless detached recovery or an exact chronological
  supersession fence;
- terminalize superseded uncertain Prompts and their Run Cards;
- adopt exactly one matching queued Prompt, or create one external Prompt;
- reserve the Answer create intent with the correct Gateway lane atomically.

This is a distinct source of Prompt ownership from Lark acceptance and ordinary
FIFO dispatch. Keeping it in `SqlitePromptStore` makes exact-turn convergence
changes share an implementation with unrelated queue and model-selection code.

## Selected module

Introduce `SqliteExternalTurnAdoptionStore` over the shared `SqliteContext`. Its
small interface contains `adoptExternalTurn` and the read query
`getActiveExternalPrompt`. Together they own the durable transition from an
unowned Herdr turn to exactly one Primary Prompt owner.

The module receives `SqliteProjectionStore` and a Prompt lookup callback. It
keeps Prompt, Run Card, and Answer outbox writes inside one transaction and does
not expose its internal ownership queries. `SqliteExternalTurnCapabilityStore`
delegates adoption and external-active lookup to this module while continuing
to compose terminal Prompt settlement and Binding queries from their existing
owners. No application-facing port changes in this slice.

## Alternatives

### Keep adoption with ordinary dispatch

Both create a running Prompt, but their authority differs. Ordinary dispatch
claims SQLite FIFO work before a TraeX effect; external adoption reconciles a
Herdr effect that already exists and must never be guessed or replayed. Combining
them obscures this safety distinction.

### Extract all external observation persistence at once

Moving adoption, completion, failure, Binding lookup, and pane lookup together
would create a broad facade around several existing modules. This slice moves
the unique multi-table ownership decision and leaves generic settlement with the
existing Prompt runtime implementation.

### Add table repositories

Per-table repositories would force the caller to coordinate ownership,
supersession, projection, and outbox transactions. That is the complexity this
deep module must hide.

## Invariants

- Binding generation, pane, and all native Agent session fields are fenced in
  the transaction before adoption.
- One runtime `turnId` has at most one Prompt owner across bindings.
- A detached turn is superseded only by its exact prompt/turn/start fence and a
  strictly later runtime start.
- A queued Prompt is adopted only when exactly one normalized request matches
  within the generation, pane, and time boundary.
- Superseded Prompt and Run Card state, new/adopted ownership, and Answer intent
  commit atomically.
- An adopted queued Prompt preserves its original identity and existing Answer
  create intent; a native external Prompt receives a deterministic Gateway lane.
- The module creates no connection and no migration.

## Testing

Add an architecture assertion that adoption methods live only in the new module
and that the capability graph constructs and delegates to it. Existing SQLite
and external-turn observer tests remain the behavioral contract for stale
bindings, ownership conflicts, queued adoption, external creation, exact
supersession, normalization, and outbox reservation. Run focused tests,
typecheck, build, the complete Vitest suite, and `git diff --check`.

## Non-goals

- No change to Herdr observation or transcript parsing.
- No change to ordinary FIFO claim, dispatch, completion, or recovery.
- No schema, card rendering, command, installation, or service restart change.
