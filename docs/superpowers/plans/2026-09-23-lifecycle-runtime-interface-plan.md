# Lifecycle Runtime Interface Implementation Plan

## Objective

Replace callback-oriented ordinary lifecycle startup with a structural runtime
interface that pairs each module's existing `start` and `stop` methods inside the
ledger while leaving policy-heavy exceptions explicit.

## Test seams

- `RuntimeLifecycleLedger` for receiver binding, typed argument forwarding, result
  preservation, cleanup registration, context forwarding, and startup failure.
- `ManagedBridgeRuntime.start()` and `stop()` for observable startup and shutdown
  behavior.

## Work packages

### 1. Characterize the structural interface

- Add a failing ledger test using a stateful runtime whose methods require their
  receiver and whose start accepts an argument.
- Require the result to be returned and the same runtime to receive shutdown context.
- Implement the smallest generic structural interface that satisfies this behavior.

### 2. Replace ordinary callback pairs

- Convert integrity, outbound/projection modules, retention, periodic observers, and
  instance reconcilers to the structural operation.
- Preserve exact resource names, shutdown stages, writer kinds, start arguments, and
  call order.
- Remove the callback-oriented ledger operation after all ordinary callers migrate.

### 3. Preserve explicit exceptions

- Keep concurrent ingress registration and shared settlement handling unchanged.
- Keep coordinator and instance-work early registration unchanged.
- Keep health factory ownership on the asynchronous resource path.
- Keep socket ingress and event-drain registrations explicit and ordered.

### 4. Strengthen architecture evidence

- Update architecture assertions to require ordinary modules on the structural path.
- Keep assertions that policy-heavy resources remain explicitly registered.
- Update architecture documentation to describe structural lifecycle ownership.

### 5. Verify and close

- Run focused ledger, managed-runtime, and architecture tests.
- Run typecheck and build, then the full suite without overlapping build output.
- Run architecture, documentation, public-release, and diff checks.
- Review against repository standards and the approved design.
- Archive the design and plan and commit without an automatically injected co-author
  trailer.
