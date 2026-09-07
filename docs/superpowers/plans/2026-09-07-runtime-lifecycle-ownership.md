# Runtime Lifecycle Ownership Implementation Plan

## Objective and authority

Implement
`docs/superpowers/specs/2026-09-07-runtime-lifecycle-ownership-design.md`.
Centralize startup, shutdown, lease-loss handling, and partial-start cleanup
behind one `ManagedBridgeRuntime` interface. Preserve every existing durability,
no-replay, exact-turn, outbox-ordering, health, and systemd behavior.

This plan is intentionally limited to runtime lifecycle ownership. Do not split
the SQLite kernel, redesign capability ports, add an import-graph checker, or
change workflow behavior in this milestone.

## Target shape

Production process control becomes:

```ts
const runtime = await createManagedBridgeRuntime({ config, buildIdentity, logger });
try {
  await runtime.start();
} catch (error) {
  // start() has already run unified startup-failure cleanup.
  process.exitCode = 1;
}

process.once("SIGINT", () => { void runtime.stop("SIGINT"); });
process.once("SIGTERM", () => { void runtime.stop("SIGTERM"); });
```

The exact signal registration may remain immediately before or after `start()`
as long as a signal cannot trigger a second cleanup path. The entry point must
not know individual workflow, projector, observer, health-server, lease, or
store shutdown order.

Internally, use two levels:

- `ManagedBridgeRuntime` is a testable class that receives a typed lifecycle
  component graph and owns phase state, startup, idempotent stop, and cleanup;
- `createManagedBridgeRuntime` is the production composition factory that
  creates the store, lease, availability probes, existing bridge component
  graph, health-server factory, and fatal-stop callback.

Do not add a public generic lifecycle registry. Keep the startup and stop order
explicit in `ManagedBridgeRuntime`, because that ordering is safety policy.

## Stage 1: Make retention shutdown await active work

Files:

- update `src/runtime/outbox-retention-maintainer.ts`;
- update `tests/outbox-retention-maintainer.test.ts`.

Steps:

1. Change `OutboxRetentionMaintainer.stop()` from `void` to `Promise<void>`.
2. Set `stopping` and clear the interval before observing the active run.
3. Capture and await `this.running` when one exists. The promise must settle only
   after no prune callback can access SQLite.
4. Keep `stop()` idempotent. Repeated calls may await the same active run and
   must not restart pruning.
5. Preserve current bounded batch behavior: after `stopping` becomes true, no new
   batch begins, while the callback already executing is allowed to finish.
6. Add a test with a deferred prune callback proving that `stop()` remains
   pending until the callback settles.
7. Add a test proving that stopping between batches prevents the next batch.
8. Update direct callers and fakes to await the new stop contract.

Gate:

```text
npx vitest run tests/outbox-retention-maintainer.test.ts
npm run typecheck
git diff --check
```

Suggested commit: `fix: await active retention work during shutdown`.

## Stage 2: Complete the shutdown component inventory

Files:

- update `src/runtime/shutdown.ts`;
- update `tests/runtime-shutdown.test.ts`;
- update `tests/external-turn-observer.test.ts` only if a focused active-stop
  case is not already covered through managed-runtime tests.

Steps:

1. Extend the typed shutdown dependencies to include every independently started
   background component currently omitted:
   - pane retention;
   - external-turn observation;
   - outbox retention.
2. Classify all three as write-capable for ownership release purposes. Pane
   retention can persist operations and invoke Herdr; external-turn observation
   persists adopted turns and projections; outbox retention deletes durable rows.
3. Stop ingress and socket-event intake before these components, then stop
   periodic/external observers before coordinator, instance, projection, and
   delivery workers.
4. Await all three stop promises under the existing shared `ShutdownContext`.
   `ExternalTurnObserver.stop()` and `PaneRetentionWorkflow.stop()` already wait
   for active work; the Stage 1 change supplies the same guarantee for retention.
5. Add ordered-call tests proving all three settle before write-fence
   deactivation, lease release, and store close.
6. Add an unsettled external-observer or retention test proving the result is
   `ownership_retained` and ownership methods are not called.
7. Preserve the existing behavior in which a failed but settled writer is logged
   and shutdown continues. Only an unsettled writer retains ownership.
8. Do not yet delete `cleanupStartupFailure`; Stage 4 removes it only after the
   managed runtime covers partial startup.

Gate:

```text
npx vitest run tests/runtime-shutdown.test.ts tests/outbox-retention-maintainer.test.ts tests/external-turn-observer.test.ts
npm run typecheck
git diff --check
```

Suggested commit: `fix: stop every runtime writer before releasing ownership`.

## Stage 3: Introduce the managed lifecycle module

Files:

- add `src/composition/managed-bridge-runtime.ts`;
- add `tests/managed-bridge-runtime.test.ts`;
- update `src/composition/create-bridge-runtime.ts` if a named internal graph
  type or smaller diagnostics facade is required;
- reuse `src/runtime/shutdown.ts` rather than duplicating its deadline and writer
  settlement rules.

Steps:

1. Define `RuntimeStopReason`, `ManagedBridgeRuntimePort`, and the concrete
   `ManagedBridgeRuntime`. The public surface is only `start()` and `stop()`.
2. Define a typed internal dependency object for the already composed runtime
   graph. Include factories for resources created during startup, especially the
   health server, so tests do not bind a socket.
3. Track ownership and started-state explicitly. At minimum distinguish:
   - store constructed;
   - lease acquired;
   - write fence active;
   - lease heartbeat active;
   - Primary tool gateway started;
   - integrity auditor started;
   - health server created;
   - delivery/projection workers started;
   - coordinator started;
   - periodic/external observers started.
4. Set a component's started flag before invoking an asynchronous `start()` that
   can partially succeed, unless its contract guarantees failure is atomic. This
   ensures startup cleanup errs toward stopping a possibly active component.
5. Implement startup in the six approved phases:
   - ownership;
   - recovery preparation;
   - operational surface;
   - durable delivery and projections;
   - ingress and recovery;
   - periodic and external observation.
6. Keep the current relative order of existing calls unless the design requires
   an earlier stop boundary. In particular, start the lease heartbeat before the
   long integrity audit and initial reconciliations.
7. Connect lease loss directly to `stop("lease-lost")`. Provide a small
   production callback such as `onFatalStop(reason, result)` so process exit-code
   mutation remains outside the lifecycle class. Tests inject a spy.
8. Implement `stop()` with one cached promise. The first reason is authoritative;
   later calls return the exact same promise and do not repeat component stops.
9. Build shutdown dependencies from recorded started-state. Optional or not-yet-
   started resources are omitted; no placeholder health server is created.
10. Have `start()` catch any startup error, await `stop("startup-failure")`,
    and rethrow the original startup error. Attach cleanup outcome only through
    structured logging; do not replace the root error.
11. Handle pre-ownership failures explicitly:
    - if the lease was never acquired, close the constructed store without
      releasing the lease;
    - if the lease was acquired but the fence was not activated, stop eligible
      components, release the lease, and close the store;
    - after fence activation, use the full unsettled-writer ownership rule.
12. Prevent `start()` after shutdown has begun. A second successful `start()` may
    either be rejected or return the original start promise, but it must never
    run phases twice; choose one behavior and encode it in tests. Prefer a cached
    start promise for consistency with idempotent stop.

Focused tests must use fake components and an ordered event array. Cover:

- the exact successful startup phase order;
- repeated `start()` does not duplicate work;
- repeated `stop()` returns the same promise;
- lease loss and SIGTERM use the same stop sequence;
- failure at each phase boundary stops only possibly started components;
- health-server creation failure requires no fake server close;
- health closes before fence/lease/store release;
- unsettled writers retain ownership;
- a read-only stop failure is logged but does not retain ownership;
- fatal-stop callback receives lease-loss and ownership-retained results.

Gate:

```text
npx vitest run tests/managed-bridge-runtime.test.ts tests/runtime-shutdown.test.ts
npm run typecheck
git diff --check
```

Suggested commit: `feat: centralize bridge runtime lifecycle ownership`.

## Stage 4: Move production bootstrap behind the managed runtime

Files:

- update `src/composition/managed-bridge-runtime.ts` with the production factory;
- update `src/main.ts`;
- update `src/composition/create-bridge-runtime.ts`;
- update `src/runtime/shutdown.ts`;
- update `tests/architecture-boundaries.test.ts`;
- update or remove obsolete startup-cleanup cases in
  `tests/runtime-shutdown.test.ts`.

Steps:

1. Add `createManagedBridgeRuntime({ config, buildIdentity, logger, onFatalStop })`.
2. Move into the production factory:
   - SQLite bundle construction;
   - lease-controller construction;
   - agent-runtime availability probes;
   - existing bridge graph construction;
   - health-server option assembly;
   - construction of `ManagedBridgeRuntime`.
3. Keep project-directory validation and config loading at the process boundary.
   They occur before a runtime resource exists and do not require lifecycle
   cleanup.
4. Reduce `main.ts` to logger/config/build setup, managed-runtime creation, signal
   registration, startup logging/error handling, and exit-code policy.
5. Signal handlers call only `runtime.stop(signal)`. If the result is
   `ownership_retained`, set a non-zero exit code. Do not stop pane retention or
   outbox retention separately.
6. The lease-loss callback inside the managed runtime performs the same stop and
   reports the fatal result through `onFatalStop`; production sets
   `process.exitCode = 1`.
7. Delete `cleanupStartupFailure` after no production or test caller remains.
   Keep `BridgeRuntimeShutdown` as an internal settlement mechanism if it still
   provides a useful deep interface; otherwise fold it into the managed module
   without duplicating behavior.
8. Narrow `createBridgeRuntime`'s returned graph where practical, but do not mix
   in the later SQLite/interface refactor. The internal factory may still return
   named components to `ManagedBridgeRuntime`; only `main.ts` must stop seeing
   them.
9. Extend architecture tests to assert that `main.ts` no longer imports or names:
   - `BridgeRuntimeShutdown`;
   - `cleanupStartupFailure`;
   - `startHealthServer`;
   - `InstanceLeaseController`;
   - individual runtime workers or their `start()`/`stop()` calls.
10. Assert that the managed runtime owns health construction, lease activation,
    lease-loss stop, and all background start/stop calls. Prefer behavioral tests
    for ordering; use source-boundary assertions only for entry-point ownership.

Gate:

```text
npx vitest run tests/managed-bridge-runtime.test.ts tests/runtime-shutdown.test.ts tests/architecture-boundaries.test.ts tests/health-server.test.ts
npm run typecheck
npm run build
git diff --check
```

Suggested commit: `refactor: hide runtime lifecycle behind composition root`.

## Stage 5: Update architecture authority

Files:

- update `docs/architecture.md`;
- update `AGENTS.md` only if its composition-root or shutdown guidance becomes
  inaccurate;
- keep the approved design and this plan under `docs/superpowers/`.

Steps:

1. Add `ManagedBridgeRuntime` to the current implementation map as the sole owner
   of startup phase ordering, lease-loss handling, shutdown sequencing, and
   partial-start cleanup.
2. Clarify that `main.ts` is only the process bootstrap and signal adapter, while
   component graph construction remains under composition.
3. Document the shutdown ownership invariant: no write fence deactivation, lease
   release, or SQLite close until all tracked writers settle.
4. Document that an unsettled writer yields `ownership_retained`; this applies to
   signals, lease loss, and startup failure.
5. List periodic retention and external-turn observation among managed writers so
   future components are classified deliberately.
6. Preserve existing operator commands and systemd documentation; there is no
   operational migration or configuration change.
7. Run the docs audit and correct any source-backed statements it flags.

Gate:

```text
npm run docs:audit
git diff --check
```

Suggested commit: `docs: define managed runtime lifecycle ownership`.

## Stage 6: Full regression and safety validation

Run the complete repository gate required for shared runtime changes:

```text
npx vitest run tests/outbox-retention-maintainer.test.ts tests/external-turn-observer.test.ts tests/runtime-shutdown.test.ts tests/managed-bridge-runtime.test.ts tests/architecture-boundaries.test.ts tests/health-server.test.ts
npm run typecheck
npm test
npm run build
npm run docs:audit
git diff --check
```

Review the final diff specifically for these safety properties:

- no shutdown path bypasses `ManagedBridgeRuntime.stop()`;
- every component started by the managed runtime has a corresponding stop;
- every SQLite writer stop is awaited before fence deactivation;
- lease loss cannot leave pane retention or external observation running;
- partial startup does not stop components that were never started;
- no cleanup path replays prompts, commands, or Herdr effects;
- health/status JSON and configuration schemas are unchanged;
- no database migration or durable schema change was introduced.

If the full suite exposes a timing-only failure, isolate and diagnose it before
changing timeouts. Do not weaken lifecycle ordering assertions to make the suite
pass.

## Commit strategy

Use thematic, independently verifiable commits in the stage order above. Do not
combine this work with the previously recommended SQLite capability or import-
graph milestones. Before any push, confirm all commits exist and the worktree is
clean. Do not create a tag, publish a release, install the service, or restart the
live unit as part of this implementation.

Every implementation commit uses the repository's required trailer:

```text
Co-authored-by: TRAE CLI <noreply@trae.ai>
```

## Completion checklist

- `ManagedBridgeRuntime` exposes only `start()` and `stop(reason)`.
- Startup has explicit, tested phases and partial-start cleanup.
- SIGINT, SIGTERM, lease loss, and startup failure share one idempotent stop.
- Pane retention, external-turn observation, and outbox retention are tracked
  writers and settle before ownership release.
- `OutboxRetentionMaintainer.stop()` awaits its active prune.
- Unsettled writers retain fence, lease, and store ownership.
- `main.ts` contains no component-level lifecycle orchestration.
- Obsolete standalone startup cleanup is removed.
- Architecture documentation matches the implementation.
- Focused tests, full tests, typecheck, build, docs audit, and diff check pass.
