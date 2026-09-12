# Prompt Recovery Deep Module Implementation Plan

**Goal:** Give Primary prompt recovery one deep SQLite module while preserving
all current behavior and transactions.

**Architecture:** `SqliteCapabilityGraph` constructs one
`SqlitePromptRecoveryStore` over the shared context.
`SqlitePromptCapabilityStore` composes dispatch and recovery implementations
behind the unchanged application-facing capability.

## Task 1: Lock the module boundary

- Add an architecture assertion for the new module and delegation path.
- Require recovery SQL and named recovery operations to leave
  `SqlitePromptStore`.
- Run the architecture test red before extraction.

## Task 2: Extract recovery behavior

- Add `src/store/sqlite/prompt-recovery-store.ts`.
- Move restart recovery, durable scanning, stale claim recovery, detached
  settlement, and manual skip into it.
- Inject the existing projection, binding transition, card-context, audit, and
  outbox collaborators required by atomic recovery operations.
- Keep the shared `SqliteContext`; create no nested database connection.

## Task 3: Compose the capability

- Construct one recovery module in `SqliteCapabilityGraph`.
- Update `SqlitePromptCapabilityStore` to delegate recovery methods to it and
  dispatch/acceptance methods to `SqlitePromptStore`.
- Keep `SqliteStoreBundle.promptRun` and current callers unchanged.
- Update test-only compatibility helpers without reintroducing recovery SQL.

## Task 4: Verify behavior and architecture

- Run `tests/architecture-boundaries.test.ts`, `tests/sqlite-store.test.ts`,
  `tests/prompt-run-safety-scan.test.ts`,
  `tests/concurrency-controls.integration.test.ts`, and
  `tests/pane-thread-lifecycle-integration.test.ts`.
- Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- Commit the extraction independently and do not install or restart the service.
