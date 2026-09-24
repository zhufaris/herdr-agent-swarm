# Consumer-Shaped Runtime Seams Design

## Purpose

Continue the repository's elegance and Clean Architecture work by making
composition dependencies explicit at the point of use. This slice changes
dependency expression only. It must not change workflow behavior, SQLite
transactions, message ordering, recovery, rendering, or external protocols.

## Problem

The application already follows ports and adapters, but two remaining patterns
weaken its dependency direction.

First, runtime modules import concrete coordinator classes only to describe a
small callable surface. `PrimaryToolGateway` and `PrimaryToolBroker`, for
example, depend on `WorkerCardDisplayWorkflow` even though they only call
`show`. This makes an infrastructure runtime aware of an application
implementation and encourages tests to cast substitutes through the concrete
class type.

Second, composition factories define their store dependencies as
`Pick<SqliteStoreBundle, ...>`. The narrowed value passed at runtime is sound,
but the interface is still derived from the global SQLite adapter bundle. A
factory therefore describes what it needs in terms of the production adapter
instead of domain ports. This obscures the fact that the factory consumes an
application-shaped capability set and makes the SQLite bundle the vocabulary of
composition.

Neither problem warrants another facade or repository layer. Both can be fixed
by moving small interfaces to the seams where callers consume them.

## Considered Approaches

### 1. Consumer-shaped domain interfaces (selected)

Define a small `WorkerCardDisplayPort` beside its domain contract and make the
workflow implement it structurally. Define each composition store set directly
from domain port types rather than deriving it from `SqliteStoreBundle`. The
composition root continues to pass the same concrete SQLite capability graph.

This gives callers a smaller interface, preserves one production adapter and
the existing in-memory test substitutes, and introduces no runtime layer.

### 2. Composition-local interfaces

Declare the interfaces next to each factory. This removes the SQLite import but
duplicates domain vocabulary and makes the same capability acquire different
names in neighboring factories. It improves dependency direction at the cost of
locality and is rejected.

### 3. A new application-store facade

Wrap `SqliteStoreBundle` behind an application-wide facade. This would replace
one broad interface with another shallow pass-through module and add no useful
behavior. It fails the deletion test and is rejected.

## Design

### Worker card display seam

Add a domain-level `WorkerCardDisplayPort` whose complete interface is the
existing `show(input): WorkerCardDisplayReceipt` operation. The input receives a
named domain type so the gateway, broker, workflow, and tests share one contract.

`WorkerCardDisplayWorkflow` remains the implementation. `PrimaryToolGateway`
and `PrimaryToolBroker` depend only on `WorkerCardDisplayPort`; they no longer
import anything from `coordinator/`. The gateway remains responsible for socket
framing, capability validation, and active-Prompt identity. The broker remains
responsible for mapping validated tool calls onto application commands. The
workflow remains responsible for the durable display reservation and outbound
wake-up.

This is a real seam because production uses the workflow adapter while focused
tests use small in-memory adapters. No new adapter class is required: TypeScript
structural conformance is sufficient.

### Composition store interfaces

Replace every exported `Pick<SqliteStoreBundle, ...>` factory type with an
explicit, consumer-shaped interface whose properties use existing domain port
types. The targeted factories are:

- outbound runtime;
- Primary runtime;
- Worker runtime;
- binding-session runtime;
- command-control runtime;
- ingress/recovery runtime;
- aggregate application runtime.

The interfaces retain the current property names so construction stays
readable. `SqliteStoreBundle` continues to satisfy them structurally and remains
the production capability graph returned by SQLite composition. Factories do
not learn about `SqliteContext`, concrete store classes, or transactions.

The aggregate application store interface is composed from the smaller factory
interfaces where that reduces duplication without creating cyclic imports. If a
composition import cycle would result, it declares the minimal domain-port
properties directly. Interface composition must not change the runtime object
graph.

### Transaction and identity constraints

The Worker runtime currently verifies that instance lifecycle and turn
capabilities share one implementation before treating them as the atomic
execution store. This runtime guard remains. The new interface documents the
requirement and keeps both capabilities separately named at construction.

No capability is split when its methods participate in one aggregate
transition. The SQLite capability graph, single primary connection, write fence,
and transaction nesting remain unchanged. Binding generations, Prompt IDs,
Worker generations, native runtime identities, and outbox lane keys are passed
unchanged.

### Dependency rule

After this slice:

```text
runtime and composition -> domain ports
coordinator workflows    -> domain ports
SQLite adapter           -> implements domain ports
composition root         -> connects implementations to consumers
```

`runtime/` must not import a coordinator implementation merely to type a
dependency. Composition may import coordinator implementations because creating
them is its job. Composition factory dependency declarations must not be derived
from `SqliteStoreBundle`; only the top-level composition root may accept that
production bundle.

## Error Handling and Observability

There are no new error modes. Existing thrown errors, structured log events,
redaction, socket limits, and durable failure transitions remain unchanged. The
refactor must not catch, wrap, rename, or reorder failures.

## Verification

Architecture tests will enforce both dependency rules:

- runtime source files do not import coordinator implementations for callable
  dependencies;
- child composition factories do not derive store interfaces from
  `SqliteStoreBundle`.

Focused Primary-tool tests will exercise list, prompt, wait, card display, Worker
creation, capability rejection, connection bounds, and restart behavior through
the new port. Existing composition and SQLite tests provide behavioral and
transaction regression coverage.

Before handoff, run the affected Vitest files, `npm run typecheck`,
`npm run build`, and the full `npm test` suite because the types span shared
composition. No install or service restart is required for design or source-only
verification; deployment remains a separate operator action.

## Non-goals

- No SQLite schema, migration, query, or transaction change.
- No new dependency-injection framework or generic repository abstraction.
- No change to Prompt or Worker FIFO behavior, steering, uncertain-effect
  handling, reconciliation, or no-replay rules.
- No change to Feishu cards, notifications, delivery intents, or outbox lanes.
- No decomposition of large workflow implementations in this slice.
- No service install, restart, project-registry change, or remote push.
