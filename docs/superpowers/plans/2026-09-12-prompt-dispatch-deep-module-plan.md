# Prompt Dispatch Deep Module Implementation Plan

**Goal:** Give Primary FIFO dispatch and exact execution settlement one deep
SQLite module without changing runtime behavior.

**Architecture:** `SqliteCapabilityGraph` constructs one
`SqlitePromptDispatchStore` over the shared context. Existing capability adapters
compose it with acceptance, recovery, adoption, and adjacent query modules behind
unchanged application ports.

## Task 1: Lock the boundary

- Add an architecture assertion for dispatch module ownership and graph wiring.
- Require claim, model fences, transcript ownership, and settlement methods to
  leave `SqlitePromptStore`.
- Run the focused test red.

## Task 2: Extract the execution protocol

- Add `src/store/sqlite/prompt-dispatch-store.ts`.
- Move FIFO claim, Prompt/model acceptance fences, transcript claim, generic
  state update, and terminal settlement.
- Move exact Prompt and active ordinary Prompt lookup with the protocol.
- Preserve the shared context and existing collaborators.

## Task 3: Compose every consumer

- Wire prompt-run, external-turn, turn-control, instance, outbox, projection, and
  test compatibility consumers to the graph-owned module as applicable.
- Keep application ports and coordinators unchanged.
- Prove no production caller retains a dispatch path through the old store.

## Task 4: Verify and commit

- Run architecture, SQLite, prompt safety, concurrency, steering, transcript,
  external observer, and pane lifecycle tests.
- Run `npm run typecheck`, `npm run build`, `npm test`, and
  `git diff --check`.
- Commit independently without installing or restarting production.
