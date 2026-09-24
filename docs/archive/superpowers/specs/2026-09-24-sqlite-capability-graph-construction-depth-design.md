# SQLite Capability Graph Construction Depth Design

## Purpose

Make SQLite capability construction explicit, type-safe, and locally
understandable without changing the database schema, capability identities,
transaction behavior, or published application interfaces.

## Problem

`SqliteCapabilityGraph` correctly owns one `SqliteContext`, migration execution,
the concrete stores, and the published application capabilities. Its current
`createStoreCluster()` implementation, however, starts with
`{} as StoreCluster`, assigns fields one by one, and lets constructor callbacks
capture other fields before TypeScript can prove they exist.

Most of these references are safe because constructors retain callbacks and do
not invoke them during construction. That temporal contract is implicit. A new
constructor-side call could observe `undefined`, and code review must mentally
reconstruct the entire assignment order to determine safety. The cast therefore
hides the most important invariant of the module instead of expressing it.

The issue is construction clarity, not the existence of collaborating stores.
Splitting each store behind another public interface would add shallow modules
and risk obscuring transactions that intentionally share one context.

## Considered Approaches

### 1. Phased construction with explicit internal links (selected)

Build complete typed phase objects and merge them into the final cluster. For
the small number of genuine construction cycles, use a private `StoreLink<T>`
that can be connected once and throws a named error if read before connection.
Callbacks close over links rather than a partially initialized object.

This eliminates the unsafe aggregate cast, documents temporal dependencies, and
retains direct concrete-store collaboration inside the SQLite adapter.

### 2. Lazy capability registry

Register factories by string key and resolve dependencies on demand. This
shortens some wiring but replaces structural typing with lookup conventions,
makes dependency discovery harder, and moves more failures to runtime. Rejected.

### 3. Split only by file

Move the current assignment blocks into several files while retaining a shared
partial object. This reduces file length but preserves the hidden initialization
contract and unsafe cast. Rejected.

## Design

### Construction-only `StoreLink`

Add a small private module under `src/store/sqlite/` with this interface:

```ts
interface StoreLink<T> {
  connect(value: T): void;
  get(): T;
}
```

The implementation accepts a diagnostic name, permits exactly one connection,
and fails clearly on an early `get()` or duplicate `connect()`. It carries no
business state and is not exported from the SQLite adapter. It is analogous to
the existing composition `RuntimeLink`, but stays local because this contract is
specifically about store construction.

Links are used only where construction order cannot directly provide a concrete
dependency. A callback such as binding card-context invalidation becomes
`cardContexts.get().invalidateBindingWorkerContexts(...)`. Once the target store
is constructed, its link is connected immediately.

### Typed construction phases

Replace `FoundationStoreFactories` and the mutable `StoreCluster` assembly with
private phase functions that return complete objects. The expected phases are:

1. **Independent stores**: thread aliases, Worker threads, operations, command
   intents, controller interpretations, inbound projects, and approvals.
2. **Binding and projection stores**: bindings and projections, using explicit
   links only for dependencies built in later phases.
3. **Delivery and Prompt stores**: outbox, Prompt stores, projection adapters,
   and natural-language confirmations.
4. **Worker and context stores**: Worker turns, instances, card contexts,
   operations, and Worker Card display.
5. **Control stores**: turn control and pane operations.

The exact phase split may be adjusted during implementation if the dependency
graph shows a smaller grouping, but each function must return a fully populated
typed object and must not accept or return `Partial<StoreCluster>`. The final
cluster is assembled with object spread from complete phase results.

All links are connected before `createStoreCluster()` returns. A construction
verification function reads every link once before publication, so no latent
unconnected dependency can enter `SqliteCapabilityGraph`.

### Public graph shape

`SqliteCapabilityGraph` keeps its existing concrete readonly properties and
`capabilityModules()` interface because tests and test helpers intentionally use
the graph as the SQLite adapter's integration seam. The constructor still:

1. creates or adopts one `SqliteContext`;
2. creates or adopts one lease store;
3. runs migrations once;
4. constructs the concrete cluster;
5. assigns the complete cluster to readonly properties.

The implementation may retain a single `Object.assign(this, cluster)` after the
cluster is complete. It must not use definite-assignment values as dependency
lookups during construction.

### Capability publication

`publishCapabilities()` remains a separate final phase. Published aliases must
retain object identity:

- `instanceLifecycle` and `instanceTurns` alias `instance`;
- `outboundIntent` aliases `outbox`;
- `answerPages` and `mainCards` alias `projection`;
- binding-session capabilities share one adapter;
- pane-control capabilities share one adapter.

No new public repository abstraction is introduced. Capability adapters remain
consumer-shaped facades over the concrete stores and the shared transaction
context.

## Dependency and Transaction Rules

- Every concrete store receives the same `SqliteContext`.
- No phase opens a connection or starts a transaction merely for construction.
- Links may be dereferenced only from operational callbacks after construction,
  never by a store constructor. An early dereference fails during tests instead
  of returning `undefined`.
- Existing outer `SqliteContext.transaction()` nesting and write-fence behavior
  remain authoritative.
- Store and capability aliases retain their current identity.
- Migration order and call count remain unchanged.

## Verification

Add focused tests for `StoreLink` connection, early-read, and duplicate-connect
behavior. Extend architecture tests to reject `{} as StoreCluster` and
`Partial<StoreCluster>` construction. Keep the existing capability identity,
shared lease/fence/context, migration-order, SQLite store, no-replay, outbox, and
Worker lifecycle suites green.

Run:

1. focused link, capability-graph, and architecture tests;
2. `npm run typecheck`;
3. `npm run build`;
4. `npm test`;
5. `npm run docs:audit`;
6. `git diff --check` and a final behavior-scope diff audit.

## Non-goals

- No schema or migration change.
- No SQL query or index optimization.
- No new database connection, repository framework, or dependency container.
- No public `StoreLink` or generic service locator.
- No change to workflow ports, queue behavior, recovery, cards, or delivery.
- No service installation, restart, configuration change, or push.
