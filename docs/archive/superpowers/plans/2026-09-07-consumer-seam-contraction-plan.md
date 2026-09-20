# Consumer Seam Contraction Implementation Plan

## Goal

Implement the approved consumer-seam design without changing persistence,
dispatch, delivery, control, or recovery behavior. Each slice ends with focused
verification and a thematic commit.

## Slice 1: Explicit startup projection composition

- Add `StartupViewProjectionStores` and a named options interface beside
  `StartupViewConverger`.
- Replace the positional constructor with an options object.
- Construct `AnswerPageWorkflow` from `stores.answerPages` and
  `MainCardWorkflow` from `stores.mainCards`; use `stores.startupViews` only for
  startup traversal and recovery.
- Update `createIngressRecoveryRuntime`, its narrow store selection, the test
  router, and startup-view tests.
- Add an architecture assertion that the converger contains no store cast and
  that production composition supplies all three named stores.
- Run `tests/startup-view-converger.test.ts`,
  `tests/architecture-boundaries.test.ts`, strict unused checking, typecheck,
  build, architecture check, and `git diff --check`.
- Commit as `refactor: make startup projection stores explicit`.

## Slice 2: Named instance workflow ports

- Add consumer-shaped types to `src/domain/ports/instance.ts`, selecting exactly
  the methods currently used by each workflow:
  - `InstanceMessagingStore`;
  - `InstanceTurnSupervisionStore`;
  - `WorkerTurnObservationStore`;
  - `InstanceRuntimeReconciliationStore`;
  - `InstanceControlStore`.
- Replace local `Store` aliases and anonymous intersections in the five target
  workflows with those named interfaces.
- Keep the SQLite instance capability and production construction unchanged;
  structural typing supplies each view over the same adapter.
- Add architecture assertions that the ports exist and target workflows no
  longer declare anonymous instance-store intersections.
- Run the focused messaging, supervisor, observer, reconciliation, and control
  test files, strict unused checking, typecheck, build, architecture check, and
  `git diff --check`.
- Commit as `refactor: name instance workflow store ports`.

## Slice 3: Architecture documentation and enforcement

- Update `docs/architecture.md` to document the startup projection composition
  and named instance workflow interfaces.
- Ensure architecture tests protect the final source shape without asserting
  implementation trivia unrelated to the seam.
- Run architecture tests, docs audit, strict unused checking, typecheck, build,
  architecture check, and `git diff --check`.
- Commit as `docs: document consumer-shaped workflow seams`.

## Final verification and completion audit

- Run the complete Vitest suite.
- Run strict unused checking, typecheck, build, architecture check, docs audit,
  and `git diff --check`.
- Inspect the actual source to verify:
  - `StartupViewConverger` has no store assertion;
  - all three startup projection stores are passed explicitly;
  - the five target instance workflows use named consumer interfaces;
  - no new `SqliteContext` or `DatabaseSync` construction exists;
  - persistence and runtime workflow diffs contain no behavior change.
- Map durability, FIFO, no-replay, outbox ordering, exact-turn fencing, and
  recovery requirements to the unchanged owning modules and relevant passing
  tests.
- Confirm the commits are thematic and `git status --short` is clean.

Do not install, deploy, restart, push, tag, create a release, or publish a
package.
