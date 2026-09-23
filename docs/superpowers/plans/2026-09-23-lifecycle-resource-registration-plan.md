# Lifecycle Resource Registration Implementation Plan

## Objective

Move repeated cleanup-before-start mechanics behind the
`RuntimeLifecycleLedger` interface while preserving the exact managed runtime
startup and shutdown contract.

## Test seams

- `RuntimeLifecycleLedger`: resource registration, startup result, failure, and
  shutdown-plan behavior.
- `ManagedBridgeRuntime.start()` and `stop()`: observable call order, concurrent
  ingress startup, recovery, interruption, and cleanup behavior.

Tests do not inspect private ledger state or private startup methods.

## Work packages

### 1. Add the lifecycle resource operation

- Add one failing ledger test proving cleanup is registered before startup and
  remains registered when startup throws.
- Implement a generic async `start` operation that accepts a cleanup entry and a
  synchronous or asynchronous callback, then returns its result.
- Add a focused result-preservation test only after the first slice is green.

### 2. Adopt the operation for direct resource pairs

- Replace direct cleanup/start pairs for integrity, health, publishers, retention,
  projections, periodic observers, and reconcilers.
- Keep recovery-only and convergence-only calls explicit.
- Keep resource names, stages, writer kinds, intervals, and call order unchanged.

### 3. Preserve special lifecycle cases

- Keep Primary tool Gateway and natural-language startup concurrent with shared
  settlement-aware cleanup; use ledger registration directly where no single
  start callback represents the pair.
- Keep Herdr socket event-drain and ingress cleanup registrations explicit so
  their reverse-registration shutdown order remains obvious.
- Retain startup interruption assertions at their existing semantic checkpoints.

### 4. Guard architecture and documentation

- Add an architecture assertion that managed startup uses the ledger resource
  operation and does not restore repeated direct registration for ordinary pairs.
- Document the cleanup-before-start invariant in architecture documentation.
- Keep the existing shutdown ledger and managed-runtime behavioral tests intact.

### 5. Verify and close

- Run focused lifecycle ledger, managed runtime, and architecture tests.
- Run typecheck, build, full tests, architecture check, docs audit, public audit,
  and diff check serially where build output could race tests.
- Review against repository standards and this design.
- Archive the completed design and plan, update the active-record index, and
  commit the implementation without an injected `Co-authored-by: TRAE CLI` trailer.
