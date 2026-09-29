# Worker Execution and Observation Implementation Plan

## Objective

Implement the approved Worker execution/observation design without changing
Worker FIFO, dispatch receipts, exact transcript ownership, no-replay recovery,
card/notification transitions, SQLite schema, or lifecycle behavior. Complete
the pass only after focused and repository-wide verification are green.

## Step 1: Characterize the dispatcher seam

Files:

- `tests/worker-turn-dispatcher.test.ts`
- existing Worker messaging, observer, supervisor, and shutdown tests

Actions:

1. Add an interface-level tracer test for the current per-instance dispatch
   behavior before moving implementation.
2. Prove that an exact transcript identity reached during a failed submission
   detaches observation and does not submit or claim the next FIFO turn.
3. Keep existing integration tests as compatibility coverage.

## Step 2: Define the consumer-shaped durable port

Files:

- `src/domain/ports/instance.ts`
- `tests/architecture-boundaries.test.ts`

Actions:

1. Add `WorkerTurnDispatchStore` as the exact `Pick<InstanceStore, ...>` used by
   live Worker dispatch.
2. Keep lifecycle, observation, supervision, messaging, and card store ports
   separate.
3. Add an architecture assertion that the dispatcher does not depend on the
   broad `InstanceLifecycleStore & InstanceTurnStore` intersection.

## Step 3: Promote the dispatch workflow

Files:

- move `src/events/instance-work-scheduler.ts` to
  `src/coordinator/worker-turn-dispatcher.ts`
- update `src/composition/create-worker-runtime.ts`
- update direct test imports

Actions:

1. Rename the class to `WorkerTurnDispatcher` and implement a narrow
   `WorkerTurnDispatcherPort`.
2. Preserve `wake`, per-instance single flight, `drain`, watch lifecycle, receipt
   classification, detached watches, diagnostics, and shutdown fencing.
3. Preserve the returned `instanceWork` composition property for lifecycle and
   health compatibility.
4. Remove the former events-layer implementation after all imports migrate.

## Step 4: Enforce architecture and update documentation

Files:

- `tests/architecture-boundaries.test.ts`
- `docs/architecture.md`
- `docs/architecture-boundary-inventory.md`

Actions:

1. Assert that Worker dispatch lives in coordinator and imports only inward
   contracts/helpers.
2. Preserve the existing observation port split between live `watch` and restart
   `recover`.
3. Document the final authority, interfaces, no-replay path, and verification
   evidence.
4. Mark the Worker seam complete only after direct evidence is green.

## Step 5: Final verification and completion audit

Run:

```bash
npx vitest run tests/worker-turn-dispatcher.test.ts tests/instance-messaging.integration.test.ts tests/worker-turn-observer.test.ts tests/instance-turn-supervisor.test.ts tests/runtime-shutdown.test.ts tests/architecture-boundaries.test.ts
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm test
git diff --check
```

Audit the design invariants against source and tests. Do not install, restart, or
push.
