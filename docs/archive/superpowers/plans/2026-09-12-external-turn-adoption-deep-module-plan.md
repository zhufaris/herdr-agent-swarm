# External Turn Adoption Deep Module Implementation Plan

**Goal:** Give externally originated Primary turn ownership one deep SQLite
module while preserving exact fences and atomic delivery intent.

**Architecture:** `SqliteCapabilityGraph` constructs one
`SqliteExternalTurnAdoptionStore` over the shared context. The existing external
turn capability composes it with Prompt settlement and Binding lookups behind the
unchanged application port.

## Task 1: Lock the boundary

- Add an architecture assertion for the module, graph construction, and
  capability delegation.
- Require `adoptExternalTurn` and `getActiveExternalPrompt` to leave
  `SqlitePromptStore`.
- Run the focused test red before extraction.

## Task 2: Extract adoption

- Add `src/store/sqlite/external-turn-adoption-store.ts`.
- Move exact Binding/session fencing, ownership conflict checks, supersession,
  queued matching, external Prompt creation, and Answer intent reservation.
- Reuse the shared context and existing projection module.

## Task 3: Compose callers

- Construct the module in `SqliteCapabilityGraph`.
- Delegate the external-turn capability and test compatibility kernel to it.
- Keep the application port and coordinator unchanged.

## Task 4: Verify and commit

- Run architecture, SQLite, external-turn observer, Herdr reconciliation, and
  pane lifecycle tests.
- Run `npm run typecheck`, `npm run build`, `npm test`, and
  `git diff --check`.
- Commit independently without installing or restarting production.
