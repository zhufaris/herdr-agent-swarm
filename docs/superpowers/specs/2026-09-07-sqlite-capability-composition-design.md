# SQLite Capability Composition Design

## Scope

Deepen the SQLite persistence module without changing schema, SQL behavior,
transaction boundaries, durability, or workflow semantics. Production
composition must consume explicit capabilities instead of a broad forwarding
facade, and each runtime composition factory must receive only the capabilities
it uses.

## Invariants

- Construct exactly one `SqliteContext` and one `DatabaseSync` connection.
- Run latest-schema bootstrap and compatibility migrations before exposing any
  capability.
- Preserve nested `SqliteContext.transaction()` behavior so cross-capability
  prompt, projection, card, event, and outbox changes stay atomic.
- Do not move SQL or workflow semantics into composition code.
- Keep legacy broad-store behavior only as a test and migration-fixture adapter.

## Production module shape

`SqliteStoreKernel` becomes the internal composition module. It constructs and
wires the existing capability implementations, then exposes those implementations
as named readonly properties. `createSqliteStoreBundle()` maps its public
consumer-facing fields directly to those capability implementations rather than
mapping every field back to the kernel object.

Operations that genuinely coordinate multiple capability modules remain behind
an explicit aggregate capability. One-line forwarding methods are not an
aggregate and should be removed from the production kernel.

The broad `SqliteBindingStore` remains test-only. It may adapt the production
capability graph for legacy fixtures, but production source and composition must
not depend on it. New tests continue to use `createTestStoreBundle()` and named
capabilities.

## Composition inputs

Each runtime factory defines or infers a store slice containing only the named
capabilities it consumes. `createBridgeRuntime()` may receive the complete bundle
because it is the parent composition function, but it passes narrow slices to
outbound, primary, worker, and application factories. This makes accidental
cross-context store access a type error while preserving one shared runtime
bundle.

## Verification

- Existing SQLite store and integration tests remain behavioral authority.
- Architecture tests verify production composition does not use the broad test
  facade and child factories do not accept `SqliteStoreBundle`.
- Run the full test suite, typecheck, build, and diff checks before completion.
