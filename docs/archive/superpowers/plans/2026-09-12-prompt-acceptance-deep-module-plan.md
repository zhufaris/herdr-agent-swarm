# Prompt Acceptance Deep Module Implementation Plan

**Goal:** Give Primary prompt admission one deep SQLite module while preserving
all behavior and atomic transitions.

**Architecture:** `SqliteCapabilityGraph` constructs one
`SqlitePromptAcceptanceStore` over the shared context.
`SqlitePromptCapabilityStore` composes acceptance, dispatch, and recovery
implementations behind the unchanged application-facing capabilities.

## Task 1: Lock the module boundary

- Extend the architecture boundary test for the new module and delegation path.
- Require admission SQL and the four named admission methods to leave
  `SqlitePromptStore`.
- Run the focused architecture test red before extraction.

## Task 2: Extract durable admission

- Add `src/store/sqlite/prompt-acceptance-store.ts`.
- Move raw enqueue, ordinary acceptance, committed-effect receipt creation, and
  interrupted continuation acceptance into it.
- Inject current Binding lookup and pending Prompt count instead of duplicating
  those collaborators.
- Preserve the shared `SqliteContext` and all current outer transactions.

## Task 3: Compose the capability

- Construct one acceptance module in `SqliteCapabilityGraph`.
- Delegate `PromptAcceptanceStore` methods through it.
- Update the test-only compatibility kernel without copying SQL.
- Keep `SqliteStoreBundle` and application callers unchanged.

## Task 4: Verify and commit

- Run the focused architecture test and `tests/sqlite-store.test.ts`.
- Run inbound routing, card interaction, event-card, and concurrency integration
  tests that exercise the admission seam.
- Run `npm run typecheck`, `npm run build`, `npm test`, and
  `git diff --check`.
- Commit the extraction independently. Do not install or restart the service.
