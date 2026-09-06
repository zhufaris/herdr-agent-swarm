# Clean Architecture Deepening Design

## Status

Approved direction on 2026-09-06. This design defines four separately
verifiable migrations. Each migration lands as its own commit and preserves the
current external behavior, durability invariants, database format, and operator
surface unless the section explicitly says otherwise.

## Goal

Deepen the persistence, application, presentation, and composition modules so
callers depend on small semantic interfaces rather than SQL structure, CardKit
payloads, concrete workflow classes, or initialization-order callbacks. The
change is architectural: it must not replay prompts, weaken identity fences,
split required SQLite transactions, rewrite frozen cards, or change supported
Lark and Herdr commands.

## Current pressure points

`SqliteBindingStore` combines schema migration, record mapping, and every
durable aggregate in one file. Domain ports are narrower than the concrete
adapter but an older wide `BindingStorePort` remains. Coordinators import
concrete CardKit renderers and therefore know presentation details. The
composition factory wires cyclic wake-up relationships through mutable
definite-assignment variables and optional callbacks.

These are depth problems rather than missing layers: complexity leaks through
interfaces and must be hidden behind existing behavioral seams.

## Stage 1: Modular SQLite implementation

Keep `SqliteBindingStore` as the single production adapter and preserve its
existing public interfaces. Internally extract cohesive persistence modules:

- schema creation and ordered migrations;
- bindings and Primary prompt lifecycle;
- Worker instances and turns;
- card projections and delivery checkpoints;
- outbox and command intents;
- operations, lease, health, and audit records.

Each internal module receives the same database handle and is private to the
SQLite adapter. It does not open another connection, own transaction nesting, or
become a new application port. Multi-aggregate transitions remain one method and
one `BEGIN IMMEDIATE` transaction. Shared row decoders live beside their owning
records rather than being copied between modules.

Extraction proceeds by cohesive method groups and must preserve schema SQL and
observable query ordering byte-for-byte where practical. The adapter delegates
to internal modules; it remains the only composition-visible persistence class.

## Stage 2: Semantic application ports

Remove the legacy wide `BindingStorePort` after proving it has no production
caller. Every workflow depends on a capability port defined for that use case.
Ports expose semantic atomic transitions, not generic CRUD or transaction
controls.

Where a coordinator currently sequences several persistence calls that must be
atomic, introduce one domain-level command/result interface. Initial candidates
are parent-pane cascade completion, prompt plus projection plus outbox
acceptance, and turn-control operation completion. A method belongs on a port
only when a production adapter and a test adapter both need the seam. Internal
SQLite helpers remain implementation details.

No workflow may depend on the concrete `SqliteBindingStore`, access its database
handle, or use the legacy `updateBinding` escape hatch. Adapter-focused tests may
continue to inspect SQLite directly; application tests observe results through
ports.

## Stage 3: Presentation seam

Introduce a `WorkflowPresentation` interface owned by the application/domain
side. It accepts typed view models or use-case results and returns an opaque
rendered card payload. A CardKit adapter implements that interface using the
existing pure renderers.

The seam is grouped by workflow capability rather than one method per card. A
workflow receives only the narrow presentation capability it needs. Coordinator
files no longer import from `src/cards/` or from Lark-specific formatting and
redaction helpers.

Presentation remains synchronous and deterministic. Durable transitions that
currently persist a view and its rendered outbox intent atomically continue to
receive the rendered payload before entering the store transaction. This stage
must not replace durable intent with an eventually consistent listener. Frozen
answer pages, CardKit sequence numbers, redaction, and payload bounds remain
unchanged.

Pure renderer tests remain adapter tests. Workflow tests replace CardKit JSON
assertions with a recording presentation adapter and assertions over the typed
result passed across the seam. A small set of product-flow tests continues to
exercise the real CardKit adapter end to end.

## Stage 4: Explicit runtime wiring

Split `createBridgeRuntime` into private composition modules for infrastructure,
outbound delivery, Primary execution, Worker execution, inbound application,
and recovery. The public factory still returns one runtime handle consumed by
`main.ts`.

Replace mutable wake-up closures and definite-assignment cycles with an
in-process `WorkWakeupHub`. The hub has explicit registration followed by a
seal/start transition. Calling an unregistered channel after sealing is a
configuration error; waking before sealing is either buffered once or rejected
according to the channel's documented startup behavior. Production and tests use
the same interface.

The hub carries wake-up hints only. SQLite remains authoritative, so dropping or
coalescing a hint cannot lose work. The existing periodic safety scans remain
the convergence mechanism. The composition modules do not acquire leases, start
the health server, or own process signals; those responsibilities remain in
`main.ts`.

## Dependency rules

The intended import direction is:

```text
domain <- coordinator <- composition <- main
   ^          ^              ^
   |          |              |
 cards adapter  runtime/store/adapters
```

More precisely:

- domain imports only domain modules and third-party validation types where a
  pure schema is itself part of the domain contract;
- coordinators import domain interfaces and application presentation ports, not
  concrete adapters or CardKit renderers;
- cards implement presentation interfaces and may use bounded formatting and
  redaction utilities;
- runtime, store, and external adapters implement domain/application ports;
- composition may import every implementation;
- `main.ts` owns process lifecycle only.

An import-graph architecture test enforces these rules. Existing targeted source
tests remain for constraints that imports alone cannot express.

## Error handling and recovery

All stages preserve current error classifications and no-replay behavior.
Extracted persistence methods must retain their transaction start, commit, and
rollback boundaries. Presentation failures cannot roll back already accepted
Agent work or cause prompt resubmission. Wake-up hub failures are configuration
failures during startup; after startup, hints remain best effort and durable
scans recover missed work.

## Migration and verification

Each stage follows the same gate:

1. Add characterization or contract tests at the target seam.
2. Move one cohesive slice without changing behavior.
3. Run affected tests, typecheck, full Vitest, and build.
4. Confirm `git diff --check` and a clean dependency-direction scan.
5. Commit the stage independently before proceeding.

Stage 1 additionally runs all SQLite migration and recovery tests after every
extracted aggregate. Stage 3 snapshots representative CardKit payloads before
and after migration. Stage 4 tests early wake-up, missing registration,
coalescing, startup recovery, and shutdown.

## Non-goals

- No database engine change or schema redesign.
- No generic repository per table.
- No event-sourcing or command-bus framework.
- No rewrite of all domain identifiers into branded types.
- No behavioral changes to commands, cards, scheduling, retry, or recovery.
- No new interface for a dependency that has only one implementation and no
  test substitution need.
