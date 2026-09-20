# Runtime Ownership and Store Retirement Design

## Status

Proposed for implementation review.

## Objective

Complete the next architecture-hardening slice without weakening durable workflow guarantees:

1. ensure every background observer settles before SQLite can close;
2. expose Worker lifecycle and Worker-turn persistence through explicit production capabilities;
3. delete only production forwarding code made redundant by those capabilities;
4. retain historical records and SQLite compatibility migrations.

## Evidence

The managed runtime already starts ExternalTurnObserver and asks it to stop before shutdown closes the store. A forced-restart observation nevertheless showed a timer callback reading bindings after the previous process closed its database. Timer cancellation alone is not a sufficient stop contract: all scheduled callbacks and the work they enqueue must settle before the observer reports stopped.

The current store composition has already extracted lifecycle, lease, health, retention, inbound dispatch, command intent, session operation, approval, card context, and Worker-card-display capabilities. InstanceLifecycleStore and InstanceTurnStore exist as consumer-focused types but are not yet bundle fields, so Worker composition continues to receive instance: InstanceStore.

## Chosen Module Shape

~~~text
ManagedBridgeRuntime
  |- stops ExternalTurnObserver as a tracked writer
  '- closes SQLite only after observer stop resolves

SqliteStoreBundle
  |- instanceLifecycle: InstanceLifecycleStore
  |- instanceTurns: InstanceTurnStore
  |- workerCardDisplay: WorkerCardDisplayStore
  '- compatibility facade: tests/helpers only
~~~

SqliteStoreKernel remains the private aggregate implementation for operations that atomically span prompt, Worker-turn, projection, event, card-context, and outbox state. This work does not split those methods into table repositories.

## Slice 1: External Turn Observer Shutdown

ExternalTurnObserver owns a single serialized periodic scan. Its stop interface must:

- prevent future timer callbacks from entering the store;
- retain and await the scheduled scan promise, including a callback that has started but not yet published itself as the current scan;
- await all per-binding observation promises;
- clear transient cursor state only after those promises settle;
- be idempotent.

The managed shutdown keeps externalTurns.stop() before lease release and store.close(). No stop path sends, retries, interrupts, or replays a prompt.

Tests cover a scan that starts immediately before stop, prove no store call happens after stop resolves, and retain the lifecycle ordering assertion that SQLite closes last.

## Slice 2: Real Instance Capabilities

SqliteStoreBundle exposes instanceLifecycle and instanceTurns as explicit views of the same kernel and SqliteContext. Worker composition receives the narrow intersections it needs:

- Worker control and runtime reconciliation use lifecycle plus the small turn-count/query intersection they require.
- Worker dispatch and transcript observation use lifecycle plus turns.
- Worker card display remains its existing independent capability.

The parent composition may retain the broad instance field temporarily for cross-cutting interaction routes. Each migrated child factory must remove its dependence on that field. There is no new database connection and nested transactions preserve their existing outermost BEGIN IMMEDIATE behavior.

## Slice 3: Retirement Rules

After production consumers have moved, remove only kernel methods that are pure delegations to an already exposed capability. A removed method must have no production caller and no atomic behavior of its own. Update architecture tests to prevent reintroducing the retired forwarding surface.

Keep these intentionally:

- SqliteBindingStore as a test-only compatibility adapter until its existing fixtures are migrated in focused follow-up slices;
- legacyDetachedWithoutIdentity, because it represents a fail-closed no-replay state rather than obsolete compatibility behavior;
- compatibility migrations and latest-schema convergence;
- historical design records under docs/archive/superpowers/.

Current documentation is updated only where it describes changed production code. Archive records are not deleted.

## Verification and Delivery

Each slice gets focused tests first. Before release, run:

~~~text
npm test
npm run typecheck
npm run build
git diff --check
~~~

Use separate thematic commits for observer shutdown, capability composition, and forwarding retirement. Do not deploy or restart the service as part of this refactor unless explicitly requested.

