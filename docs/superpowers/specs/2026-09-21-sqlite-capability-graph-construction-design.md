# SQLite Capability Graph Construction Refactor

## Goal

Make SQLite construction and migration orchestration easier to understand and
safer to change without altering the persistence contract. The refactor keeps
one transactional SQLite implementation while expressing its construction as
explicit phases and its migration sequence as named, fixed-order phases.

This is a structural refactor. It does not redesign stores, ports, schema, SQL,
or transactions.

## Behavioral compatibility

The refactor must not change:

- `createSqliteStoreBundle(path)`, `createSqliteStoreBundleFromContext(context,
  lease)`, or the `SqliteStoreBundle` interface;
- the single `SqliteContext`, `DatabaseSync` connection, lease, and write-fence
  ownership model;
- any store class or domain port;
- schema objects, migration versions, SQL statements, indexes, triggers, views,
  persisted state names, or data canonicalization behavior;
- migration execution order, including repeated compatibility passes;
- transaction boundaries or the atomicity of cross-table workflow operations;
- capability alias identity where one implementation intentionally satisfies
  several consumer ports;
- the lease-before-business-migration startup boundary;
- the test-only `SqliteStoreKernel` and `SqliteBindingStore` compatibility
  behavior.

No migration is reordered merely because its numeric version suggests a
different order. Version numbers record history; they are not a dependency
graph.

## Current problem

`SqliteCapabilityGraph` currently performs four jobs in one constructor: it
opens or adopts the SQLite context, runs migrations, creates concrete stores,
wires a cyclic transaction-participating store cluster, and publishes
consumer-shaped capabilities. Correctness depends on construction order and
late-bound callbacks, but that dependency structure is implicit in a long
constructor.

`SqliteMigrations.run()` similarly contains the correct historical sequence as
one long method. Its order is deliberate and includes repeated Gateway and
outbox compatibility passes after legacy rebuilds. The method is safe but makes
the phase boundaries and cross-domain ordering constraints hard to see.

The largest coupling cluster contains projections, outbox, prompts, Worker
turns, instances, bindings, and card contexts. These modules call one another
through narrow callbacks while sharing the same `SqliteContext`. This is real
transactional coupling, not accidental repository coupling, and must not be
hidden by creating separately owned database adapters.

## Considered approaches

### A. Explicit construction phases in one capability graph

Keep one `SqliteCapabilityGraph`, but delegate its implementation to named
private construction phases: context and migration preparation, concrete store
cluster construction, and capability publication. Express migrations through
fixed-order named phase methods.

This is the selected approach. It improves locality and navigation while keeping
the actual transactional topology honest.

### B. Domain-specific subgraphs

Create separate Binding, Prompt, Worker, projection, and delivery graphs. This
would reduce individual file size, but the existing cross-domain callbacks and
atomic transitions would require broad inter-graph interfaces or partially
initialized objects. The result would expose more implementation knowledge and
make the module shallower.

### C. Generic dependency and migration registries

Register stores and migrations dynamically, then derive construction or
execution order from keys and dependencies. This would add indirect lookup,
runtime validation, and an invented ordering model. It would also make the
historical migration sequence less reviewable. The current fixed topology does
not justify that generality.

## Selected architecture

The production seam remains the two existing store-bundle factories. They create
one internal SQLite module and return only `SqliteStoreBundle`. Production
composition does not gain access to concrete stores, raw SQLite, or migration
helpers.

Internally, construction has three phases.

### 1. Context and foundation

The graph adopts an existing `SqliteContext` and lease store or creates them
from a path exactly as it does today. It creates `SqliteMigrations`, completes
the fixed migration sequence, and only then creates business capabilities.

Low-coupling foundation stores are constructed first. These include stores whose
dependencies do not require the central cyclic cluster, such as lease, thread
alias, Worker Session thread, operations, command-intent, inbound-project, and
approval persistence.

The exact membership of this internal construction group may follow existing
constructor dependencies. It is not a new public interface or an ownership
boundary.

### 2. Transactional store cluster

One internal construction function creates the connected Binding, projection,
outbox, Prompt, Worker, instance, card-context, pane-operation, and control
stores. It retains the current late-bound callbacks used to break constructor
cycles. Every member receives the same `SqliteContext`; no child opens a
connection or simulates a distributed transaction.

The cluster is returned as one private typed object. Its type lists concrete
implementation stores because it is internal construction data, not a domain
port. Callbacks remain consumer-shaped and no general locator or mutable
registry is introduced.

Construction order is explicit and tested. A callback may reference a store that
is assigned later only when the existing implementation already relies on that
late binding and no callback can run during construction.

### 3. Capability publication

A private capability publisher wraps or aliases the concrete cluster into the
same consumer-shaped modules currently returned by `capabilityModules()`. The
public store-bundle mapping remains unchanged.

Intentional aliases retain object identity. In particular, one implementation
may continue to satisfy multiple lifecycle, projection, Binding-session, pane
control, or instance ports. The publisher does not clone, proxy, or lazily
recreate capability implementations.

`SqliteCapabilityGraph` may keep concrete accessors required by the test-only
`SqliteStoreKernel`. Those accessors remain unavailable through production
composition and are not added to `SqliteStoreBundle`.

## Migration orchestration

`SqliteMigrations.run()` becomes a short, explicit sequence of private phase
methods. Each phase contains the current calls in the same relative and absolute
order. The intended phases are:

1. inspect pre-schema state and temporarily remove a stale `run_cards_view` when
   required;
2. create the latest idempotent schema;
3. apply initial additive card, Worker lifecycle, and inbound compatibility;
4. apply Binding and Prompt compatibility;
5. apply Worker, projection, and card-context compatibility;
6. apply delivery-lane, control, natural-language, and Controller compatibility;
7. execute historical versions 2, 3, and 4 data convergence with their current
   individual `BEGIN IMMEDIATE` transactions and current timestamp behavior;
8. apply final outbox, recovery, and Gateway compatibility, including the
   deliberate repeated Gateway-column and claim passes after possible legacy
   rebuilds;
9. recreate the temporarily removed view at its current point and retain current
   query-index placement.

These names document intent but do not authorize moving calls to make domain
grouping look cleaner. If the existing sequence puts a call in a surprising
place, compatibility wins over aesthetic grouping.

Migration methods stay ordinary TypeScript methods. There is no migration array,
version sorter, topological scheduler, dependency-injection container, or plugin
registry. The existing migration-domain classes remain responsible for their SQL.

The runtime callback used by startup recovery to canonicalize legacy Answer
targets remains available through a narrow private bridge from the graph's
migration owner. It does not expose general migration execution to workflows.

## Error handling and lifecycle

Migration failure remains fail-fast during capability-graph construction. No
business capability is published from a partially migrated graph. Existing
transaction rollback behavior remains inside each migration operation.

Store-construction failures propagate to the caller and follow the existing
bootstrap cleanup path. The refactor does not add retries, partial graph reuse,
or recovery from programmer errors in dependency wiring.

Graph closure continues through the lifecycle adapter and closes the one shared
context. Internal construction helpers do not acquire independent resources that
need separate shutdown.

## Testing strategy

Tests use the existing production factories or test compatibility kernel rather
than reaching into private construction helpers. The refactor adds focused
characterization where the current suite does not make these properties explicit:

- a migration-order test records named migration method calls and proves the
  fixed sequence, repeated passes, view handling, and versions 2–4 convergence
  placement are unchanged;
- capability-publication tests prove intentional aliases retain object identity,
  including the instance, Binding-session, pane-control, projection, and outbox
  capability families;
- context and lifecycle tests prove all capabilities continue to share one
  context, write fence, and close operation;
- existing migration fixtures continue to prove upgrade behavior from historical
  schemas, including rebuilds, triggers, indexes, and canonicalization;
- existing SQLite integration tests continue to verify cross-table transaction
  atomicity and no-replay behavior.

Tests must not lock private helper names or require a generic registry shape. The
observable seams are migration effects, capability identity where intentional,
and behavior through named store ports.

## Implementation boundaries

This refactor may:

- add private construction types and helper modules under `src/store/sqlite/`;
- shorten the `SqliteCapabilityGraph` constructor and `SqliteMigrations.run()`;
- add characterization tests for ordering, alias identity, and shared lifecycle;
- update architecture documentation to describe the explicit phases.

It must not:

- alter SQL text, schema objects, migration numbers, or migration conditions;
- reorder, merge, remove, or make migrations dynamically discoverable;
- alter transaction boundaries, timestamps, or repeated compatibility passes;
- change concrete store responsibilities or domain ports;
- change the production `SqliteStoreBundle` shape or factory signatures;
- introduce another SQLite connection or context;
- expose raw stores or migration control to production workflows;
- remove the test compatibility facade or broadly reorganize its 5,875-line
  integration suite in this change;
- include unrelated runtime, CardKit, Lark, Controller, or configuration work.

## Success criteria

- A maintainer can identify context setup, migration execution, store-cluster
  wiring, and capability publication without reading one long constructor.
- `SqliteMigrations.run()` presents a short fixed-order phase list whose methods
  preserve the exact current call sequence.
- The cyclic transaction-participating store cluster is explicit and remains on
  one context.
- Production callers see the same store bundle and consumer-shaped interfaces.
- All existing migration fixtures and SQLite workflow tests pass unchanged except
  for focused characterization additions.
- A diff audit confirms no SQL, schema, version, transaction, or public-interface
  change.
