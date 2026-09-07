# Architecture Convergence Design

## Objective

Complete the remaining architecture cleanup without changing prompt FIFO,
exact-turn fencing, no-replay recovery, durable outbox ordering, CardKit paging,
or SQLite transaction semantics. The work deepens existing modules instead of
adding a second architecture beside them.

## Scope and sequence

The implementation is split into five independently reviewable slices:

1. deepen ProjectRouteIndex into the canonical project catalog;
2. divide application composition into three internal assembly graphs;
3. expose more SQLite capability modules directly and shrink the compatibility
   kernel;
4. replace repeated runtime lifecycle booleans with an ordered internal ledger;
5. split the migration implementation by domain behind one ordered runner.

Each slice is committed only after its focused tests, typecheck, build, and diff
checks pass. SQLite, lifecycle, or migration slices additionally run the full
test suite before commit.

## Canonical project catalog

Rename ProjectRouteIndex to ProjectCatalog and keep it immutable. It owns only
validated-project lookup and ambiguity rules: lookup by project ID, binding
resolution with project-ID precedence and unique-workspace fallback, unique
explicit space-name lookup, unique workspace-and-cwd lookup, and visible
space-name formatting.

It does not own authorization, binding lifecycle, Herdr observation, project
selection state, or configuration validation. Unknown and ambiguous lookups
fail closed. A stale binding project ID never falls back through the workspace.

Workflows stop constructing their own project maps where the catalog expresses
the same rule. Callers that require a map only to pass it into pane identity
validation are changed to pass the catalog instead. The catalog is constructed
inside each top-level workflow from its existing validated project list; it is
not introduced as a process-global mutable registry.

## Application composition graphs

createApplicationRuntime remains the public application composition function
but delegates construction to three private composition modules:

- binding/session graph: provisioning, session administration, pane closure,
  pane retention, retired-pane cleanup, and runtime reconciliation;
- command/control graph: model selection, pane control, command gateway, card
  interactions, operations queries, delivery recovery, and instance
  interactions;
- ingress/recovery graph: inbound dispatcher, message/card routing, startup
  view convergence, startup recovery, and the final InboundRouter.

These modules contain wiring only. They receive narrow store slices and explicit
runtime dependencies, return the workflows needed by the next graph, and do not
move workflow decisions into composition. Cyclic runtime callbacks continue to
use explicit callbacks or the existing RuntimeLink; no dependency-injection
container is introduced.

## SQLite capability graph

Preserve exactly one SqliteContext, one DatabaseSync connection, and the
existing nested transaction implementation. Extend the existing kernel
composition so createSqliteStoreBundle can return coherent capability modules
directly when they already implement a complete consumer port.

One-line kernel forwarding methods are removed only after every production and
test consumer uses the owning module. Cross-capability operations remain behind
an aggregate module when they atomically update multiple tables, projections,
events, or outbox intents. The broad kernel may continue as a temporary test
compatibility adapter, but production bundle fields must not point to it merely
for convenience.

No dynamic proxy, table-per-repository split, second database connection, or
transaction moved into composition is allowed.

## Managed runtime lifecycle ledger

Keep ManagedBridgeRuntime as the single lifecycle authority. Internally,
replace the growing set of started booleans with a typed ordered ledger. A
successful start step registers its matching cleanup exactly once. Normal stop
and startup failure consume the same ledger in reverse order.

The ledger is not a generic callback framework. Entries carry a stable name,
writer classification, and cleanup operation so shutdown diagnostics and the
ownership-retention rule remain explicit. The health server remains a dynamic
entry because it exists only after successful creation. Lease acquisition,
write-fence activation, and store closure retain their special safety policy:
unsettled writers must retain SQLite ownership.

Startup order and externally visible health/readiness behavior do not change.
Lease loss, signals, and startup failure still converge through the same
idempotent stop promise.

## Migration modules

Keep SqliteMigrations.run as the only public migration entry point and make its
call order visibly authoritative. Move private migration implementations into
domain-focused modules: binding and session; prompt and turn; cards,
projections, and outbox; Worker instance and Worker turn; and retired-schema
convergence.

Extraction is mechanical. Existing SQL, ordering, data repair, foreign-key
handling, and idempotency are preserved. A migration is not deleted because its
name is legacy or because the latest schema does not need it. Removal requires
proof that it is unreachable and does not converge any supported historical
schema.

Tests must open a latest empty database and representative historical schema
fixtures, run migration twice, check the final schema and repaired data, and run
PRAGMA foreign_key_check.

## Architecture constraints

- Domain and coordinator modules do not import composition or SQLite modules.
- Composition modules contain construction and callbacks, not workflow policy.
- Every binding-to-project compatibility decision uses ProjectCatalog.
- Production child factories accept capability-focused store slices.
- Only the SQLite capability graph constructs SqliteContext.
- Only the ordered migration runner decides migration order.
- Only ManagedBridgeRuntime owns process-level start and stop ordering.

Architecture tests enforce these import and construction constraints where a
static assertion is reliable.

## Verification and completion

Final verification requires strict unused checking, typecheck, the full test
suite, build, documentation audit, architecture check, and git diff checking.
Completion also requires a clean worktree and thematic commits. Installation,
service restart, remote push, tags, GitHub Release creation, and npm publication
are outside this scope.
