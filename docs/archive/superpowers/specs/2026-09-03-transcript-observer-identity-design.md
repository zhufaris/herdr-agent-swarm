# Transcript Observer Identity Design

## Purpose

Make the cursor-reuse identity of `ExternalTurnObserver` an explicit domain
value rather than an inlined colon-delimited string. The observer uses this
identity to decide whether its transcript cursor and in-memory turn projection
state may be reused for a binding, or must be discarded and reopened.

## Scope

Add a pure domain function that derives an observer identity from a binding's
generation, pane ID, and complete native transcript session identity. It
returns `null` unless all session fields and a pane ID are present.

`ExternalTurnObserver` will use the function for both regular observation and
detached-turn supersession handoff. A changed generation, pane ID, session
source, agent, kind, or value produces a different identity and therefore a
fresh cursor/projection state.

## Boundaries and invariants

- The identity is an in-process cache key only; it is not persisted, sent to
  Lark, or used as authorization evidence.
- Exact durable session identity remains the gate for transcript access and
  SQLite adoption.
- A missing session remains ineligible for observation; the refactor does not
  add fallback discovery.
- The string representation must be unambiguous even if a future session field
  contains a separator character.
- Cursor ownership, transcript parsing, external-turn adoption, supersession
  fences, and lifecycle delivery remain in `ExternalTurnObserver`.

## Verification

Add direct identity tests proving stable derivation and divergence on each
generation, pane, and session field. Retain external observer tests for cursor
reuse, direct turn adoption, and handoff completion; then run typecheck, build,
and `git diff --check` before the implementation commit.
