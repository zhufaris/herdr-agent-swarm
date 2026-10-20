# Herdr Events Reader Deep-Module Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Turn `HerdrEventsReader` into a small stable facade over private,
cohesive protocol, source/session, cursor, projector, and identity modules
without changing any observable runtime behavior.

**Architecture:** Composition continues to construct one
`HerdrEventsReader`. The facade owns `AgentTranscriptReaderPort` policy and
failure translation. Private modules under `src/runtime/herdr-events/` isolate
Core JSON/CLI transport, source and historical-turn resolution, durable cursor
settlement, deterministic lane identity, and pure event projection. No new
domain Port or concrete SQLite dependency is introduced.

**Spec:** `docs/superpowers/specs/2026-09-30-herdr-events-reader-deep-module-design.md`

## Constraints

- Preserve the current dirty worktree and all behavior already present in the
  uncommitted `herdr-events-reader.ts` implementation.
- Keep `HerdrEventsReader` as the only production import path from outside the
  private cluster.
- Keep the existing constructor and `AgentTranscriptReaderPort` interface.
- Do not alter Core commands, timeout values, batch limits, schema limits,
  unavailable reasons, durable inbox schema, reducer revision, or settlement
  policy.
- Never replay Agent input and never infer workflow state from CardKit output.
- Move tests only after their replacement surface exists; delete only exact
  duplicate implementation-shaped coverage.
- Do not install or restart the live service as part of this refactor.

## Task 1: Extract the normalized Core protocol client

**Files:**

- Create: `src/runtime/herdr-events/protocol.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Create: `tests/herdr-events-protocol.test.ts`
- Modify: `tests/herdr-events-reader.test.ts`

- [ ] Move all raw snake-case Zod schemas and the `AgentEvent` normalized type
  to `protocol.ts`.
- [ ] Wrap the one bounded command runner in semantic operations for attach,
  sources, locate, read, capabilities, receipt, turn list, and recovery.
- [ ] Keep response-size, JSON, schema, and command timeout behavior identical.
- [ ] Return normalized camel-case DTOs so callers never build CLI arguments or
  inspect raw response envelopes.
- [ ] Add focused tests for argument construction, bounds, normalization, and
  identity mismatch; retain facade-level failure-policy tests.
- [ ] Run protocol and facade tests plus typecheck.

## Task 2: Extract the stateful event projector

**Files:**

- Create: `src/runtime/herdr-events/event-projector.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Create: `tests/herdr-event-projector.test.ts`
- Modify: `tests/herdr-events-reader.test.ts`

- [ ] Move Core-event-to-`AgentTranscriptObservation` reduction and all
  presentation-safe helpers behind one `project(events)` operation.
- [ ] Encapsulate turn identity, canonical start, final answer, sequence,
  emitted message IDs, and outstanding Tool calls.
- [ ] Expose internal snapshot/restore values only to the durable cursor.
- [ ] Keep redaction, rendering bounds, Tool nesting, Goal, plan, reasoning
  heading, truncation, and lifecycle semantics byte-for-byte compatible.
- [ ] Move projector-only cases from the broad facade suite and remove their
  exact duplicates.
- [ ] Run projector and facade tests plus typecheck.

## Task 3: Extract durable event cursor and lane identity

**Files:**

- Create: `src/runtime/herdr-events/event-cursor.ts`
- Create: `src/runtime/herdr-events/identity.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Create: `tests/herdr-event-cursor.test.ts`
- Create: `tests/herdr-event-identity.test.ts`
- Modify: `tests/herdr-events-reader.test.ts`

- [ ] Move batch splitting, finite-stream completion, inbox ingestion,
  checkpoint continuation, one-event delivery, acknowledgement gating,
  reducer snapshots, rollback, retry, and quarantine continuation into the
  cursor.
- [ ] Move deterministic live/recovered lane keys and Core envelope conversion
  into `identity.ts`.
- [ ] Keep the cursor's external surface equal to
  `AgentTranscriptCursorPort`; keep batch-reader and projector seams private.
- [ ] Prove ingest-before-observe, acknowledgement-before-next-read,
  state rollback, healthy-neighbour ordering, restart replay, and recovered
  stream completion in focused tests.
- [ ] Remove only cursor/identity cases now duplicated by focused tests.
- [ ] Run cursor, identity, facade, Core inbox store, and recovery tests.

## Task 4: Extract source/session resolution and reduce the facade

**Files:**

- Create: `src/runtime/herdr-events/source-session.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Modify: `tests/herdr-events-reader.test.ts`

- [ ] Move Pane/terminal validation, descriptor resolution, bounded attach
  convergence, boundary location, native identity, capability caching, and
  historical recovery request orchestration into `source-session.ts`.
- [ ] Keep unavailable-reason translation and live-versus-recovered policy in
  the facade.
- [ ] Preserve exact source, agent, session, turn, and canonical-start fences.
- [ ] Reduce `HerdrEventsReader` to public methods, boundary policy, DTO mapping,
  and cursor construction.
- [ ] Confirm the facade constructor and every public method remain unchanged.
- [ ] Run the complete Herdr Events Reader suite and typecheck.

## Task 5: Enforce the private cluster and clean obsolete code/tests

**Files:**

- Modify: `scripts/check-architecture-imports.mjs`
- Modify: `tests/architecture-boundaries.test.ts`
- Modify: `tests/herdr-events-reader.test.ts`
- Modify: focused tests created above
- Modify: `docs/architecture.md` only for module ownership, not behavior

- [ ] Reject imports of `src/runtime/herdr-events/*` from production files
  outside the facade and the private cluster.
- [ ] Verify the projector has no Herdr, command runner, concrete store, or
  SQLite imports.
- [ ] Remove superseded helpers from the facade and exact duplicate test
  fixtures/assertions.
- [ ] Keep public behavior cases, cross-module integration cases, and safety
  regressions at the facade level.
- [ ] Document the facade and private module responsibilities.
- [ ] Run `git diff --check` and the architecture checks.

## Task 6: Complete verification and audit

- [ ] Run `npx vitest run tests/herdr-events-protocol.test.ts
  tests/herdr-event-projector.test.ts tests/herdr-event-cursor.test.ts
  tests/herdr-event-identity.test.ts tests/herdr-events-reader.test.ts`.
- [ ] Run Core inbox, recovery, transcript observer, and integration tests
  affected by the facade.
- [ ] Run `npm run architecture:check` and the architecture-boundary suite.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run the full `npm test` suite.
- [ ] Confirm no public interface, configuration, migration, Core command,
  timeout, batch limit, safety invariant, or unrelated dirty file changed.
- [ ] Inspect the final diff for accidental reformatting and duplicate tests.
