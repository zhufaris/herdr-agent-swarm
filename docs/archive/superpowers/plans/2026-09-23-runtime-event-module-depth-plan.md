# Runtime Event Module Depth Implementation Plan

## Objective

Remove the shallow Herdr hint forwarding seam and centralize ordered Primary
reconciliation behavior in `HerdrEventRouter` without changing runtime behavior.

## Work packages

### 1. Characterize the function seam

- Update runtime integration tests to obtain a connected Herdr hint consumer.
- Prove the returned function forwards the exact hint and event lifecycle signal.
- Preserve a direct router test without a signal.

### 2. Replace the shallow forwarding interface

- Replace the object-only `HerdrHintConsumer` seam with a function type.
- Let `RuntimeLink` hold function capabilities and expose one stable deferred
  callable for composition-time cycles.
- Make `RuntimeEventIntegration` expose that callable and connect the router's
  bound handler once construction reaches the other side of the cycle.
- Remove `RuntimeEventIntegration.handleHerdrHint()`.
- Pass the connected function directly into `createInfrastructureRuntime()`.
- Require the production infrastructure callback to receive an `AbortSignal`.

### 3. Deepen the router

- Extract one private ordered Primary reconciliation operation.
- Express pane, workspace, and full routes through that operation.
- Preserve independent promise startup and `Promise.allSettled` failure isolation.
- Preserve coalescing under the active drain's lifecycle signal.

### 4. Simplify subscriber cancellation locally

- Name the shutdown-to-event abort linkage if doing so reduces conditional noise.
- Keep one subscriber-owned controller and real `hintDrain` settlement.
- Do not introduce a separate lifecycle module.

### 5. Verify and finish

- Run focused router, subscriber, integration, and managed-runtime tests.
- Run typecheck, build, the full test suite, architecture check, documentation
  audit, public audit, and diff check.
- Review separately against repository standards and the approved design.
- Archive the completed design and plan, then commit the implementation and
  inspect the final commit body for unwanted trailers.
