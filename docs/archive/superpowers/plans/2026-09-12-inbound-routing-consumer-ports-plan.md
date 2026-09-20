# Inbound Routing Consumer Ports Implementation Plan

**Goal:** Remove the transitional routing-plus-acceptance aggregate and expose
the two real consumer capabilities directly.

## Task 1: Lock the seam

- Add an architecture assertion rejecting the intersection interface, inherited
  capability adapter, and `inboundMessages` bundle field.
- Require `InboundMessageRoutingWorkflow` to accept named stores.
- Run the focused architecture test red.

## Task 2: Rewire production

- Replace `store` with `{ routing, promptAcceptance }` in the workflow.
- Delete `SqliteIngressCapabilityStore`.
- Remove `inboundMessages` from the graph, bundle, and composition picks.
- Inject `inboundRouting` and `promptAcceptance` directly.

## Task 3: Rewire tests

- Update focused routing fixtures and shared router construction.
- Keep compatibility drivers only as adapters to the two named inputs.

## Task 4: Verify and commit

- Run architecture, inbound routing/dispatcher, concurrency, typecheck, build,
  the full suite, and `git diff --check`.
- Commit independently without installing or restarting production.
