# DDD and Clean Architecture Phase 2 Implementation Plan

## Objective and authority

Implement all eight stages in
`docs/superpowers/specs/2026-09-06-ddd-clean-architecture-phase2-design.md`
without changing observable workflow behavior. The architecture document and the
design's authority, no-replay, atomicity, identity-fence, and CardKit ordering
rules are hard gates.

## Stage 1: Worker card ownership policy

Files:

- add `src/domain/worker-card-ownership.ts`;
- add `tests/worker-card-ownership.test.ts`;
- update `src/coordinator/instance-interaction-workflow.ts`;
- update `tests/instance-routing.integration.test.ts`.

Steps:

1. Characterize current Worker Main and Worker Task stale/ownership outcomes.
2. Model immutable identity inputs and explicit rejection reasons.
3. Replace duplicated coordinator predicates with the pure policy.
4. Verify direct Worker-card replies still route as Primary messages.

Gate: focused tests, typecheck, build, diff check.

## Stage 2: Prompt-run decomposition

Files:

- add `src/coordinator/prompt-safety-scanner.ts`;
- add `src/coordinator/prompt-run-registry.ts`;
- add `src/coordinator/transcript-observer.ts`;
- add `src/coordinator/prompt-turn-executor.ts`;
- update `src/coordinator/prompt-run-workflow.ts`;
- add or update focused prompt-run tests.

Steps:

1. Extract safety scan state/backoff first with unchanged scheduler behavior.
2. Extract per-binding worker and turn ownership.
3. Extract transcript acquisition, exact identity claim, conflict filtering, and
   attached/detached polling behind a narrow observer contract.
4. Move one claimed turn's dispatch and terminal classification into the executor.
5. Keep the facade API and FIFO drain loop stable.

Gate: safety-scan, prompt execution, detached recovery, concurrency, typecheck,
build, full test, diff check.

## Stage 3: Instance interaction use cases

Files:

- add focused modules under `src/coordinator/instance-interactions/`;
- update `src/coordinator/instance-interaction-workflow.ts`;
- update instance routing and Worker card integration tests.

Steps:

1. Extract conversation context resolution.
2. Extract directory/detail query assembly.
3. Extract Worker Task and Worker Main card handlers.
4. Leave the original class as a normalized-input router.

Gate: instance routing, Primary/Worker flow, typecheck, build, diff check.

## Stage 4: Runtime reconciliation layers

Files:

- add pure `src/domain/binding-runtime-convergence-policy.ts`;
- add scheduler, snapshot collector, and converger modules under `src/coordinator/`;
- update `src/coordinator/herdr-runtime-reconciler.ts`;
- update reconciliation tests.

Steps:

1. Characterize full, workspace-scoped, and pane-scoped reconciliation.
2. Extract pure observation classification.
3. Extract snapshot loading/normalization.
4. Extract coalescing, cooldown, timer, and diagnostics.
5. Route every entry point through one convergence executor.

Gate: reconciler tests, external-turn tests, typecheck, build, full test, diff check.

## Stage 5: Binding provisioning use cases

Files:

- add modules under `src/coordinator/binding-provisioning/`;
- update `src/coordinator/binding-provisioning-workflow.ts`;
- update provisioning, startup recovery, reset, and attach tests.

Steps:

1. Extract the durable Primary provisioning saga without splitting checkpoint
   ownership.
2. Extract project selection and recovery.
3. Extract attach, reattach, replace, and failed-reset recovery.
4. Preserve the public facade consumed by startup and session operations.

Gate: provisioning/recovery tests, typecheck, build, full test, diff check.

## Stage 6: Typed durable delivery intents

Files:

- add `src/domain/delivery-intent.ts`;
- add an outbound intent materializer under `src/events/`;
- update outbound records, schema/migrations, stores, and dispatcher;
- update projection and outbox tests.

Steps:

1. Add nullable typed-intent schema fields while retaining legacy payload rows.
2. Materialize immutable Main Card snapshots with a pinned renderer revision.
3. Migrate ordinary Run Card and Worker card intents.
4. Migrate Answer stream creation/recovery only after compatibility tests pass.
5. Remove renderer callbacks and raw card parameters from core-facing store ports
   when no caller remains.

Gate: migration, projection, outbox lane, CardKit stream/recovery, architecture,
typecheck, build, full test, diff check.

## Stage 7: Domain types and ports

Files:

- add context-owned type modules under `src/domain/`;
- add ingress/diagnostic types under their owning application or adapter modules;
- split large port files by consumer;
- retain temporary re-exports from `domain/types.ts`.

Steps:

1. Move leaf delivery, runtime observation, project selection, and diagnostics types.
2. Move Binding and Prompt types after their consumers use context imports.
3. Replace broad presentation dependencies with workflow-specific ports.
4. Split `prompt.ts` and `workflow.ts` while retaining compatibility exports.
5. Add architecture assertions for forbidden cross-context imports.

Gate: architecture tests, typecheck, build, full test, diff check.

## Stage 8: Store kernel and test migration

Files:

- add `tests/helpers/create-test-store-bundle.ts`;
- migrate tests using `SqliteBindingStore` in thematic batches;
- update `src/store/sqlite-store-kernel.ts`, `src/store/sqlite-store.ts`, and
  architecture tests.

Steps:

1. Provide a test bundle that owns lifecycle and exposes narrow capabilities.
2. Migrate workflow tests, then projection/outbox tests, then persistence tests.
3. Move any remaining compatibility-only helpers into test support.
4. Remove production exports/references to the broad facade when the usage scan is
   empty.
5. Keep cross-capability atomic operations in the shared kernel/context.

Gate: zero production compatibility-facade imports, bounded documented test-only
usage if removal is impractical, architecture tests, typecheck, build, full test,
diff check.

## Commit strategy

Use one or more thematic commits per stage. Never combine a schema migration with
unrelated coordinator decomposition. Every commit includes the required
`Co-authored-by: TRAE CLI <noreply@trae.ai>` trailer.

## Final completion audit

Map stages 1-8 to source and test evidence; scan for remaining broad interfaces,
renderer callbacks, presentation imports, and compatibility facade consumers; run
all focused gates, `npm run typecheck`, `npm test`, `npm run build`, and
`git diff --check`; inspect branch status and commit history. Any retained item must
have a concrete architectural reason documented in the design or architecture
guide.
