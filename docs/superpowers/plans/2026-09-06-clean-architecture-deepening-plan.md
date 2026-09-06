# Clean Architecture Deepening Implementation Plan

## Objective

Implement the approved four-stage architecture migration without changing the
database schema, observable workflow behavior, supported commands, or runtime
durability guarantees. Each stage must be independently reviewable, verified,
and committed before the next stage begins.

The governing design is
`docs/superpowers/specs/2026-09-06-clean-architecture-deepening-design.md`.
If implementation pressure conflicts with that design, preserve the documented
invariants and revise the plan rather than silently widening scope.

## Cross-stage invariants

- SQLite remains the durable source of truth; Herdr events and in-process
  wake-ups remain hints only.
- Keep one `DatabaseSync` connection per `SqliteBindingStore`. Extracted SQLite
  modules receive that handle and never open or close it.
- Preserve every existing `BEGIN IMMEDIATE`, commit, rollback, SQL predicate,
  idempotency key, and observable query ordering where practical. An extracted
  helper must not start a nested transaction when its caller owns the atomic
  transition.
- Keep `SqliteBindingStore` as the only composition-visible persistence adapter
  during Stage 1. Do not create table-per-repository interfaces.
- Keep rendering synchronous and deterministic. Where rendering currently
  precedes an atomic persistence transition, the rendered payload must still be
  available before that transition begins.
- Preserve no-replay handling, exact-turn identity fences, frozen-answer-page
  behavior, ordered CardKit sequences, redaction, payload bounds, and periodic
  recovery scans.
- Do not add event sourcing, a command bus, speculative interfaces, remote
  approval or denial, arbitrary terminal input, process kill, or pane kill.

## Stage 1: Modularize the SQLite implementation

### 1.1 Extract instance lease and write-fence persistence

Files:

- add `src/store/sqlite-instance-lease.ts`;
- update `src/store/sqlite-store.ts`;
- retain public characterization coverage in `tests/instance-lease.test.ts`;
- update `tests/sqlite-store.test.ts` only if a store-level regression case is
  needed.

Implementation:

1. Move the fenced-table inventory and the implementations of
   `activateWriteFence`, `deactivateWriteFence`, the internal fence assertion,
   `acquireInstanceLease`, `renewInstanceLease`, and `releaseInstanceLease` into
   one internal module.
2. Give the module the existing `DatabaseSync`; it must not create a connection,
   run migrations, or close the database.
3. Keep acquisition's `BEGIN IMMEDIATE` transaction, early commit, successful
   commit, and rollback behavior unchanged. Keep renewal and release as their
   existing single statements.
4. Delegate the six public `SqliteBindingStore` methods to the internal module.
   Do not expose the internal module through a domain port or composition.
5. Keep the write-fence trigger names, covered tables, operations, SQL lease
   check, and cleanup-on-failed-activation unchanged.

Verification:

- `npx vitest run tests/instance-lease.test.ts tests/sqlite-store.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

Commit: `refactor: extract sqlite lease persistence`

### 1.2 Continue with cohesive persistence slices

After the lease extraction passes, inventory public store methods by durable
aggregate and extract one slice at a time. Prefer this order because it moves
self-contained infrastructure first and leaves cross-aggregate transitions
until their transaction ownership is explicit:

1. health, integrity, and audit records;
2. operations and command intents;
3. outbox records, lane heads, quarantines, and delivery checkpoints;
4. card projections, answer pages, and card-context invalidations;
5. Worker instances, workspace leases, turns, and Worker projections;
6. bindings, inbound records, Primary prompts, and recovery transitions;
7. ordered schema creation and migrations.

For each slice:

- characterize the public adapter behavior before moving it;
- move row types and decoders only when they have a single clear owner;
- pass transaction-owning callbacks or keep a cross-aggregate method on the
  facade when extraction would split an atomic transition;
- delegate from `SqliteBindingStore` without changing its public method surface;
- run the nearest focused store, migration, recovery, outbox, projection, or
  concurrency tests before proceeding to the next slice.

Stage gate:

- all SQLite, migration, recovery, concurrency, outbox, and projection tests;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`;
- confirm production composition imports only `SqliteBindingStore`, not internal
  persistence modules.

If Stage 1 grows beyond a safely reviewable diff, commit independently verified
sub-slices while retaining a final Stage 1 gate before starting Stage 2.

## Stage 2: Replace the wide store seam with semantic ports

Files to inspect and update:

- `src/domain/ports.ts`;
- `src/domain/ports/*.ts`;
- `src/coordinator/*.ts`;
- `src/events/*.ts`;
- `src/runtime/*.ts`;
- `src/composition/create-bridge-runtime.ts`;
- test fakes and `tests/architecture-boundaries.test.ts`.

Implementation:

1. Use an import and type-usage scan to prove whether `BindingStorePort` has any
   production consumer other than `SqliteBindingStore` and type-level parameter
   reuse inside that adapter.
2. Replace internal `Parameters<BindingStorePort[...]>` coupling with named input
   types owned by the appropriate semantic port.
3. Move any still-required capabilities into existing narrow ports in
   `src/domain/ports/`. Add a method only when a production adapter and a test
   adapter both cross that seam.
4. For coordinator sequences that must be atomic, expose one semantic transition
   and result rather than transaction controls or generic CRUD. Prioritize:
   parent-pane cascade completion, prompt plus projection plus outbox acceptance,
   and turn-control completion.
5. Remove `BindingStorePort` and the generic `updateBinding` escape hatch only
   after all production callers have migrated. Retain purpose-built binding
   transitions with explicit generation or identity fences.
6. Add architecture assertions that coordinators, events, and runtime modules do
   not import the concrete store or the retired wide port.

Verification:

- focused workflow tests for every changed port and fake;
- SQLite transaction tests for each new semantic transition;
- `npx vitest run tests/architecture-boundaries.test.ts`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

Commit: `refactor: narrow persistence ports by workflow`

## Stage 3: Introduce the synchronous presentation seam

Files to add or update:

- add application-owned presentation interfaces and typed inputs under
  `src/domain/ports/` or a focused `src/domain/presentation/` directory;
- add a CardKit presentation adapter under `src/cards/`;
- update coordinator and event modules currently importing `src/cards/`;
- update composition wiring;
- update focused workflow, renderer, snapshot, and architecture tests.

Implementation:

1. Inventory direct card imports from `src/coordinator/` and `src/events/`, then
   group them by workflow capability rather than by individual card function.
2. Define small synchronous interfaces whose inputs are domain view models or
   use-case results and whose outputs are opaque rendered card payloads. Do not
   expose CardKit element types to coordinators.
3. Implement those interfaces in a CardKit adapter by delegating to the existing
   pure renderers and bounded formatting/redaction helpers.
4. Inject only the presentation capability each workflow needs. Keep rendering
   before store calls wherever the payload participates in an atomic durable
   transition.
5. Convert workflow tests from CardKit structure assertions to recording-adapter
   assertions over typed presentation inputs. Retain renderer tests and a small
   number of end-to-end product-flow payload tests.
6. Extend the architecture test to reject imports from `src/cards/` in
   coordinators. Treat event projectors that are deliberately presentation
   adapters explicitly rather than allowing an undocumented exception.

Verification:

- focused tests for every migrated workflow;
- representative before/after CardKit snapshots for Primary, Worker, answer,
  operation, and error cards;
- markdown, redaction, pagination, frozen-page, and stream-sequence tests;
- `npx vitest run tests/architecture-boundaries.test.ts`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

Commit: `refactor: isolate workflow presentation`

## Stage 4: Make runtime composition wiring explicit

Files to add or update:

- add `src/composition/work-wakeup-hub.ts`;
- split private builders from `src/composition/create-bridge-runtime.ts` into
  focused composition modules for infrastructure, outbound delivery, Primary
  execution, Worker execution, inbound application, and recovery;
- update composition and startup tests;
- update `tests/architecture-boundaries.test.ts`.

Implementation:

1. Characterize current startup order and every mutable callback cycle:
   Herdr socket routing, turn-control outbound wake-up, Primary priority wake-up,
   Worker priority wake-up, Worker observation, prompt/external-turn observation,
   and runtime reconciliation.
2. Implement `WorkWakeupHub` with named channels, explicit registration, and a
   seal/start transition. Document per channel whether one pre-seal hint is
   coalesced or whether invocation is rejected. Missing registration after seal
   is a startup configuration error.
3. Replace mutable optional wake-up variables first, keeping handlers and
   periodic scans unchanged. Add tests for pre-seal behavior, duplicate or
   missing registration, coalescing, and post-seal dispatch.
4. Extract composition builders around stable dependency groups. Builders may
   return concrete implementations for the root factory to connect, but must not
   acquire the SQLite lease, start the health server, register process signals,
   or create a second runtime owner.
5. Keep `createBridgeRuntime(config, store, logger, availability)` and its returned
   runtime handle compatible with `src/main.ts` and shutdown wiring.
6. Add startup-recovery and shutdown tests proving that a missed hint converges
   through SQLite scans and no accepted work depends on an in-memory callback.

Verification:

- focused wake-up hub, runtime composition, startup recovery, Herdr event,
  scheduler, lease-loss, and shutdown tests;
- `npx vitest run tests/architecture-boundaries.test.ts`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

Commit: `refactor: make runtime wiring explicit`

## Final architecture review

1. Compare `main...HEAD` and confirm each stage is represented by an isolated,
   explainable commit.
2. Re-run the import-direction scan and verify the intended dependency flow:
   domain <- coordinator <- composition <- main, with cards, store, runtime, and
   external adapters implementing inward-owned interfaces.
3. Search for `BindingStorePort`, coordinator imports from `src/cards/`, concrete
   store imports outside composition/store tests, mutable definite-assignment
   cycles in the runtime factory, and internal SQLite modules imported by
   composition.
4. Run `npm run typecheck`, `npm test`, `npm run build`, and
   `git diff --check main...HEAD`.
5. Review durability-sensitive diffs specifically for transaction ownership,
   idempotency, fencing, prompt replay, outbox ordering, frozen pages, and
   shutdown detachment.
6. Record any intentionally deferred improvement as a concrete follow-up; do not
   hide unfinished architecture work behind a passing build.
