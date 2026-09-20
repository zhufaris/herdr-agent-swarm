# Runtime Lifecycle Ownership Design

## Status

Approved for specification. Implementation starts after review of this document.

## Objective

Make one deep runtime module own Herdr Agent Swarm startup, shutdown, and
startup-failure cleanup. Normal process signals, loss of the SQLite instance
lease, and failure during any startup phase must converge through the same
idempotent lifecycle interface. SQLite ownership is released only after every
write-capable activity has settled.

This milestone addresses runtime lifecycle ownership only. It does not redesign
SQLite capability interfaces, add import-graph enforcement, or change prompt,
Worker, reconciliation, projection, or delivery semantics.

## Current Problem

`main.ts` currently constructs the lease, unpacks many internal runtime objects,
starts them in a hand-written order, and assembles a second hand-written shutdown
list. Some components are stopped outside `BridgeRuntimeShutdown`; other
components, including the external-turn observer, are not part of its dependency
list. The lease-loss callback enters shutdown through a different path from
SIGINT and SIGTERM, while an early startup failure uses another partial cleanup
path.

This distributes lifecycle knowledge across the composition factory, `main.ts`,
and the shutdown helper. Adding a periodic worker or observer therefore requires
the maintainer to update several places correctly. A missed update can leave a
SQLite writer or Herdr external-effect producer alive while the write fence,
lease, or database is being released.

## Chosen Design

Introduce a `ManagedBridgeRuntime` module with a deliberately small external
interface:

```ts
export type RuntimeStopReason =
  | "SIGINT"
  | "SIGTERM"
  | "lease-lost"
  | "startup-failure";

export interface ManagedBridgeRuntime {
  start(): Promise<void>;
  stop(reason: RuntimeStopReason): Promise<BridgeRuntimeShutdownOutcome>;
}
```

The module owns the store bundle, lease controller, composed application
runtime, health server, startup phase tracking, and shutdown coordinator. Its
interface hides component ordering, partial-start cleanup, and writer settlement
rules. `main.ts` retains only process-level responsibilities: load configuration
and build identity, create the logger, construct the managed runtime, register
signals, log an unrecoverable startup failure, and set the process exit code.

The existing component factories remain responsible for constructing adapters
and workflows. They provide an internal component graph to the managed runtime;
they do not expose that graph to the process entry point.

## Lifecycle Phases

Startup proceeds through explicit ordered phases. A phase is recorded as started
before later phases may begin, allowing failure cleanup to stop exactly the
components that may be active.

1. **Ownership**
   - acquire the instance lease;
   - activate the SQLite write fence;
   - start the lease heartbeat and install the lease-loss callback.
2. **Recovery preparation**
   - prepare interrupted Worker-turn recovery;
   - start the Primary tool gateway;
   - start and run the initial SQLite integrity inspection;
   - perform initial instance-runtime and Worker-turn reconciliation.
3. **Operational surface**
   - start the health server using the composed diagnostics providers.
4. **Durable delivery and projections**
   - start the outbox dispatcher and retention maintainer;
   - start conversation and card-context projection;
   - converge queue feedback.
5. **Ingress and recovery**
   - start the inbound coordinator and its ordered startup recovery.
6. **Periodic and external observation**
   - perform the initial pane-retention scan, then start periodic retention;
   - start external-turn observation, instance reconciliation, Worker-turn
     observation, and Herdr socket events.

The runtime is ready only after all phases complete. Existing `/health`, `/ready`,
and `/status` behavior remains unchanged; this milestone changes ownership of
their construction, not their external contract.

## Unified Shutdown

`stop(reason)` is idempotent. The first call creates the shutdown promise; all
later calls return that same promise, regardless of whether they originate from
a signal, lease loss, or startup failure. No code path performs component cleanup
outside this method.

Shutdown follows a safety-oriented order:

1. stop accepting new Lark, card-action, socket-event, and Primary-tool ingress;
2. stop periodic jobs and observers that can initiate Herdr effects or SQLite
   writes, including pane retention and external-turn observation;
3. stop instance dispatch, Worker-turn observation, reconciliation, command
   lanes, prompt execution, and session-operation workers;
4. stop projection, card-context, queue-feedback, outbox-retention, and outbox
   delivery workers, waiting for their active work to settle;
5. close the health server;
6. deactivate the write fence, release the lease, and close SQLite.

The existing shared shutdown deadline remains. Components capable of writing
SQLite are tracked as writers. If any writer has not settled after the deadline
and abort-settlement grace period, shutdown returns `ownership_retained` and does
not deactivate the fence, release the lease, or close the store. This conservative
failure mode is preserved for every stop reason.

Read-only or transport components may report shutdown failures without retaining
SQLite ownership, provided they cannot subsequently invoke a writer. Component
classification is explicit in the managed runtime rather than inferred from a
method name.

## Startup Failure

A startup exception is handled by calling the same `stop("startup-failure")`
entry point. Cleanup uses the recorded phase state and stops every component that
may have started, in reverse safety order. There is no separate partial cleanup
function with a second dependency list.

The ownership phase also participates in this model:

- failure before lease acquisition closes the newly created store without trying
  to release an unowned lease;
- failure after lease acquisition but before write-fence activation releases the
  lease after eligible components settle;
- failure after fence activation obeys the full writer-settlement rule;
- failure before health-server creation does not require a placeholder server.

Startup failure never starts a component solely so that it can be stopped.

## Lease Loss

The lease-loss callback calls `stop("lease-lost")` directly. It does not invoke
`BridgeRuntimeShutdown` separately and does not signal the process as an indirect
cleanup mechanism. The process exit code becomes non-zero after shutdown begins.

Lease loss must stop pane retention, external-turn observation, Herdr socket
handling, prompt and Worker execution, and all SQLite writers before ownership is
released. If those writers do not settle, the runtime retains the fence, lease,
and open store exactly as it does for a timed-out signal shutdown.

## Component Contracts

Every managed background module must provide a stop operation that settles only
when its active work can no longer access SQLite or initiate a new external
effect. Timer cancellation alone is insufficient.

As part of this milestone:

- `ExternalTurnObserver.stop()` becomes a managed writer stop and is always
  invoked;
- `PaneRetentionWorkflow.stop()` remains asynchronous and waits for its active
  scan;
- `OutboxRetentionMaintainer.stop()` becomes asynchronous, cancels its timer,
  and waits for the current prune run;
- compound Worker dispatch/observation shutdown remains one tracked writer group
  unless separating it improves settlement diagnostics without changing order;
- start and stop methods remain idempotent where repeated calls are possible.

The implementation may use a small internal phase ledger or typed lifecycle
entries. It must not expose a general-purpose public callback registry. Startup
and shutdown order are domain-specific safety policy and should remain explicit,
typed, and reviewable.

## Error Handling and Diagnostics

Component stop failures are logged with the component name and stop reason. The
managed runtime records deadline expiry, failed components, timed-out components,
and unsettled writer names in the final shutdown result. Existing secret
redaction and bounded error handling remain in force.

Only the first stop reason controls the shutdown execution. A later signal may be
logged as a duplicate request but cannot start another cleanup sequence or alter
ownership decisions.

No shutdown path retries a TraeX prompt, replays an uncertain command, kills a
pane, or repairs durable state from Lark output. Existing no-replay and authority
invariants remain unchanged.

## Testing

Focused lifecycle tests use instrumented fake components and an ordered event log
to verify:

1. successful startup executes phases in the required order;
2. SIGINT and SIGTERM use the same stop path;
3. lease loss stops periodic jobs, observers, and writers before releasing the
   fence or lease;
4. failure after each startup phase stops only components that may have started;
5. repeated `stop()` calls return the same result and run cleanup once;
6. an active outbox-retention prune is awaited;
7. an active external-turn observation is awaited;
8. an unsettled writer returns `ownership_retained` and leaves the fence, lease,
   and store active;
9. a read-only stop failure is reported but does not by itself retain ownership;
10. the health server is closed before SQLite ownership is released.

Existing `runtime-shutdown` tests are retained or migrated to the managed-runtime
interface according to which seam they exercise. Architecture tests assert that
`main.ts` no longer imports `BridgeRuntimeShutdown`, `cleanupStartupFailure`,
`startHealthServer`, or individual workflow types, and does not enumerate
component start/stop calls.

Before handoff, run the affected lifecycle and architecture tests, the full
Vitest suite, `npm run typecheck`, `npm run build`, and `git diff --check`.

## Migration Strategy

Implement the change in behavior-preserving slices:

1. make retention shutdown await active pruning and add focused tests;
2. extend the existing shutdown implementation to cover every active component
   and prove the ordering through tests;
3. introduce `ManagedBridgeRuntime` around the proven lifecycle sequence;
4. move lease, health, startup, and unified stop ownership out of `main.ts`;
5. delete the obsolete standalone startup-cleanup path;
6. update architecture documentation to name the managed runtime as lifecycle
   owner.

The intermediate states must compile and preserve the existing production entry
point. No migration changes durable database state.

## Non-goals

- Splitting `SqliteStoreKernel` or changing capability ports.
- Replacing source-string architecture tests with an import graph.
- Changing health or status response schemas.
- Introducing a generic dependency-injection container or lifecycle framework.
- Changing systemd installation, restart policy, or service commands.
- Changing prompt scheduling, Worker scheduling, CardKit projection, outbox
  ordering, or Herdr reconciliation behavior.

## Completion Criteria

- `main.ts` uses only the managed runtime lifecycle interface and process-level
  signal/error handling.
- Every timer, observer, dispatcher, projector, reconciler, and writer started by
  the runtime is represented in its unified shutdown policy.
- Normal signals, lease loss, and startup failure share one idempotent stop path.
- Active retention and observation work settles before SQLite ownership is
  released.
- Unsettled writers retain the write fence, lease, and open store.
- Startup failures at all tested phases clean up only resources that may have
  started.
- Existing durability, no-replay, outbox, and exact-turn fencing behavior remains
  unchanged.
- Focused tests, the full test suite, typecheck, and build pass.
