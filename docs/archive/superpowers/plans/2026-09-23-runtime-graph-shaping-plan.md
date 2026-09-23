# Runtime Graph Shaping Implementation Plan

Status: completed and archived.

## Objective

Replace the flat bridge-runtime result with lifecycle, health, and operations
groups, and move combined worker diagnostics beside the worker modules that own
their source state.

## Work packages

### 1. Characterize worker diagnostics ownership

- Add a focused composition test for the combined instance-worker diagnostic
  provider returned by `createWorkerRuntime()`.
- Verify dispatch state/failure precedence and observer/turn fields.
- Move the existing aggregator from `createBridgeRuntime()` only after the test
  fails at the intended seam.

### 2. Shape the bridge graph

- Return `lifecycle`, `health`, and `operations` groups from
  `createBridgeRuntime()`.
- Keep lifecycle fields aligned with `ManagedBridgeRuntimeDependencies` without
  moving lifecycle policy into the factory.
- Put runtime-owned health providers into `health`; keep Gateway transport in
  `operations`.
- Preserve optional Herdr socket presence without `undefined` fields.

### 3. Simplify managed composition

- Consume the grouped graph without broad top-level destructuring.
- Spread the lifecycle group into `ManagedBridgeRuntime` construction.
- Spread the health group into `startHealthServer()` and add only host-owned
  configuration, stores, lease, Gateway, projects, and build identity locally.
- Preserve exact startup and cleanup registration order.

### 4. Guard the architecture

- Add an architecture assertion that the bridge graph exposes the three named
  groups.
- Prevent `createManagedBridgeRuntime()` from reintroducing broad flat runtime
  destructuring.
- Update architecture documentation with graph ownership.

### 5. Verify and finish

- Run focused worker composition, managed-runtime, health, and architecture
  tests.
- Run typecheck and build sequentially with the full test suite to avoid the
  repository's build-output race.
- Run architecture check, documentation audit, public audit, and diff check.
- Review separately against repository standards and the approved design.
- Archive the design and plan, commit the implementation, and remove any
  injected commit trailer.
