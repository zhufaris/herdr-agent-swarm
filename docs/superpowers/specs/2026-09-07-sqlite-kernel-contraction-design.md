# SQLite Kernel Contraction Design

## Status

Approved direction for the architecture-hardening sequence after event, store,
and outbox hardening. Implementation starts only after review of this written
specification.

## Objective

Turn `SqliteStoreKernel` from a 773-line combination of object graph builder,
cross-aggregate transaction owner, and broad forwarding facade into a small
internal assembly module. Production workflows should receive deep capability
modules whose interfaces match real use cases, while one `SqliteContext`, one
database connection, and all existing atomic transitions remain intact.

This is an architecture refactor. It does not introduce new product behavior,
schema changes, queues, event logs, or recovery authorities.

## Evidence and problem statement

The current bundle already exposes focused implementations for lifecycle,
lease, health, instances, outbox, inbound dispatch, operations queries, command
intents, session operations, retention, card context, and Worker-card display.
However, the following production capabilities still point directly at
`SqliteStoreKernel`: turn control, prompt acceptance and execution, answer and
main cards, projection and queue feedback, binding provisioning and runtime
reconciliation, pane operations, routing and recovery, card interactions,
external turns, model selection, session administration, and pane retention.

Many kernel methods are one-line forwarding methods. Other methods are valuable
cross-table transactions. Treating both categories alike obscures transaction
ownership and makes the kernel's public surface nearly as complex as all of its
implementations combined.

## Alternatives considered

### A. Transaction-owned capability modules, then port and assembly cleanup

Group operations by atomic use case, move each group behind one deep capability
module, expose it directly from the bundle, then narrow ports to the operations
their consumers actually use. Finish by replacing the kernel's broad public
surface with a private assembly graph.

This is the selected approach. It removes caller knowledge without moving
transactions into workflows or creating pass-through adapters.

### B. Narrow TypeScript ports before moving implementations

This improves compile-time dependency declarations quickly, but production
objects would still be views over the same broad kernel. It changes the visible
shape without increasing module depth or locality, and risks creating many
shallow adapters.

### C. Split the kernel mechanically by table or method count

This produces smaller files but breaks operations that intentionally span
bindings, prompts, projections, card contexts, and outbox intent. It would make
transaction ownership harder to see and is rejected.

## Target architecture

```text
createSqliteStoreBundle(path)
             |
             v
    SqliteCapabilityGraph
    - one SqliteContext
    - schema and migrations
    - internal dependency wiring
             |
       +-----+----------------------+
       |                            |
       v                            v
 focused persistence modules   deep aggregate modules
 queue/projection/outbox/...   prompt runtime, binding session,
                              turn control, card delivery context
       |                            |
       +-------------+--------------+
                     v
            SqliteStoreBundle ports
                     |
                     v
             application workflows
```

`SqliteCapabilityGraph` is an internal implementation detail. It constructs the
shared context, runs migrations, resolves the dependency graph, and returns
named capability modules. It does not implement workflow ports and does not
forward persistence operations.

Aggregate modules own transactions that cross focused persistence modules. A
module qualifies for extraction only when deleting it would force transaction
policy, fencing, ordering, or projection coordination back into multiple
callers. Simple read composition remains on an existing focused module where
possible.

## Ordered implementation slices

### 1. Introduce an internal capability graph

Move construction, migration execution, dependency callbacks, lifecycle
adapter creation, and capability exposure out of the broad kernel into
`SqliteCapabilityGraph`. It owns the only `SqliteContext` and supplies explicit
named modules.

At this stage the existing kernel may adapt the graph for compatibility. No SQL
or transaction body moves, and production bundle behavior remains identical.
Architecture tests must prove that only the graph constructs `SqliteContext`
and that migrations run before capabilities are exposed.

### 2. Expose projection and card capabilities directly

Replace kernel-backed bundle fields for `ProjectionStore`, `MainCardStore`,
`AnswerPageStore`, `QueueFeedbackStore`, and `WorkerTurnCardStore` with focused
modules or one coherent projection aggregate where operations atomically reserve
outbox intent.

Do not split reservation methods from their projection and outbox transaction.
Frozen-page behavior, CardKit sequence ordering, view-version checks, and
delivery checkpoint semantics remain unchanged.

### 3. Deepen prompt acceptance and prompt runtime ownership

Make prompt acceptance and prompt execution complete capability modules instead
of kernel projections. The modules own FIFO claim, prepared/accepted dispatch
fences, detached observation, completion/failure projection, and outbox
reservation.

The typed post-commit receipt remains the only prompt-acceptance path for
process-local effects. Duplicate acceptance returns no effects, nested
transactions expose no effects before the outer commit, and rollback discards
them. Work that may have reached TraeX is never automatically replayed.

### 4. Deepen binding lifecycle and reconciliation ownership

Create one binding-session aggregate module for provisioning, reset cutover,
runtime observation, title/orphan/degradation projection, session
administration, retired-pane cleanup, and pane retention operations that share
binding-generation fences.

This module coordinates existing binding, prompt, projection, card-context,
pane-operation, and outbox modules through the shared context. Fresh Herdr
observation remains the convergence authority; the module does not infer runtime
state from cards.

### 5. Consolidate control and recovery capabilities

Expose exact-turn control, pane control, model selection, external-turn
adoption, card interactions, delivery recovery, and inbound/startup recovery
through the smallest coherent set of aggregate modules. Grouping follows shared
fences and atomic state transitions, not UI command names.

Exact binding generation, pane, native session, logical turn, and runtime turn
checks remain inside the transaction-owning module. No remote approval, raw
terminal input, process kill, or pane kill interface is added.

### 6. Narrow ports after implementation ownership is real

Remove unrelated recovery and operational methods from
`PromptAcceptanceStore`. Separate startup convergence capabilities from normal
message acceptance. Replace intersection-heavy bundle types, especially the
current `turnControl` and `commandIntents` entries, with named consumer ports.

Port changes follow actual workflow usage. No port is split merely to reduce a
method count, and no one-implementation hypothetical seam is added without
leverage for callers or tests.

### 7. Retire the production-facing kernel facade

After every production bundle entry references a named capability, remove
`SqliteStoreKernel` from `src/` or reduce it to a test-only compatibility
adapter under `tests/helpers`. Production construction imports only the internal
capability graph. Tests that need broad fixture access may compose named
capabilities explicitly, but new tests must exercise the same consumer interface
as production.

Update `docs/architecture.md` and architecture checks to describe the final
module graph rather than the transitional kernel.

## Preserved invariants

- Exactly one `SqliteContext` and one `DatabaseSync` connection exist per
  store bundle.
- Only the outermost managed transaction issues `BEGIN IMMEDIATE`, `COMMIT`, or
  `ROLLBACK`; nested capability calls participate in it.
- Durable inbound intent precedes dispatch, and durable outbound intent precedes
  wake-up or Lark delivery.
- A binding dispatches at most one ordinary turn; later ordinary prompts remain
  FIFO.
- A prompt that may have reached TraeX is detached and observed, never
  automatically replayed.
- Outbox lane ordering, compare-and-set transitions, retry, quarantine,
  dead-letter, frozen-page, and supersession behavior do not change.
- SQLite remains authoritative for workflow state and delivery intent; fresh
  Herdr snapshots remain authoritative for runtime convergence; Lark remains a
  projection.
- Exact-turn steering and stop remain identity-fenced and local approval remains
  in Herdr.
- Historical database migrations and idempotent schema convergence remain
  supported.

## Error handling and recovery

Module extraction must preserve current error categories and transaction
rollback behavior. A failed durable transition emits no process-local effect.
An external delivery that was durably checkpointed is not retried because a
post-delivery observer failed. Startup scans, outbox safety scans, detached-turn
observation, and fresh Herdr reconciliation remain the recovery mechanisms; the
refactor adds no second replay channel.

Circular construction dependencies are resolved with narrow callbacks that are
internal to `SqliteCapabilityGraph`. They must not leak into workflow ports. If
a callback cluster grows beyond simple capability access, it is evidence for a
deeper aggregate module rather than a reason to introduce a service locator.

## Testing strategy

Each slice is an independently reviewable commit and must include focused
architecture and behavioral tests before proceeding.

- Architecture tests verify that production bundle fields no longer point at a
  broad kernel, only the capability graph constructs `SqliteContext`, child
  composition factories retain narrow store slices, and SQLite modules do not
  import coordinator, event-delivery, or composition code.
- SQLite tests cover nested commit/rollback, post-commit receipts, duplicate
  acceptance, FIFO claims, dispatch uncertainty, generation fencing, projection
  plus outbox atomicity, CAS delivery transitions, dead-letter recovery, and
  historical migrations.
- Integration tests cover prompt concurrency, steering, detached recovery,
  runtime reconciliation, card projection, and lane ordering through production
  consumer ports rather than the compatibility facade.
- Every slice runs its affected Vitest files, strict unused checking, typecheck,
  build, architecture checks, and `git diff --check`. Slices spanning workflow,
  persistence, or shared runtime behavior also run the full suite before commit.

## Completion criteria

The work is complete only when all of the following are true:

1. Production construction has one internal capability graph and one shared
   SQLite context/connection.
2. No `SqliteStoreBundle` production field points to a broad kernel object.
3. Cross-table transactions have named owning aggregate modules; they are not
   distributed into workflows or composition.
4. Broad prompt/startup/control intersections are replaced by consumer-shaped
   ports backed by real modules.
5. The production kernel facade is removed or has no forwarding surface.
6. Documentation and architecture checks describe and enforce the final graph.
7. Focused and full tests demonstrate preservation of durability, FIFO,
   no-replay, outbox ordering, exact-turn fencing, and recovery behavior.
8. Strict unused checking, typecheck, build, architecture check, and
   `git diff --check` pass.
9. The worktree is clean and the implementation is represented by thematic,
   independently verified commits.

Installation, service restart, remote push, tags, GitHub Release creation, and
npm publication remain outside this scope.
