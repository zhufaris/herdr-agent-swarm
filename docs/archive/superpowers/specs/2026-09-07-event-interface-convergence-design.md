# Event Interface Convergence Design

## Status

Approved as a narrow follow-up to the unified event integration design.

## Objective

Finish the event-integration ownership boundary without changing runtime
behavior. Composition subgraphs should depend on reliability-role interfaces,
and `LarkOutboxDispatcher` must not create a private outbound notifier when its
caller omits one.

## Design

`RuntimeEventIntegration` remains the only production composition owner of the
in-process lifecycle bus, inbound notifier, outbound notifier, prompt scheduler,
work wake-up hub, and Herdr hint link. It continues to expose the concrete
objects needed by the composition root, but child composition factories accept
only the existing role interfaces they actually use:

- lifecycle publication and subscription use `LifecycleEventPublisher` and
  `LifecycleEventSubscriber`;
- inbound delivery uses `InboundWorkNotifier`;
- prompt scheduling uses `PromptWorkScheduler`;
- outbound delivery uses `OutboundWorkNotifier`.

Where one child graph needs both lifecycle roles, its local option type uses the
intersection of the two interfaces. This does not introduce another abstraction
or adapter.

`LarkOutboxDispatcher` changes its constructor so `OutboundWorkNotifier` is a
required dependency. Production composition supplies
`RuntimeEventIntegration.outboundWork`. Tests that construct the dispatcher
directly supply an explicit in-process notifier or a narrow test notifier. The
dispatcher retains its periodic safety scan, so notifier loss remains a latency
issue rather than a correctness issue.

## Invariants

- SQLite remains authoritative for inbound records, workflow state, and outbox
  intent.
- Fresh Herdr observation remains authoritative for pane and agent state.
- No generic event publisher or shared replay contract is introduced.
- Outbound intent is persisted before a notifier wake-up.
- Exact-turn fencing, FIFO claims, no-replay recovery, CardKit ordering, and
  transaction boundaries are unchanged.
- Tests may construct individual in-process event implementations to exercise
  their interfaces; only production composition ownership is centralized.

## Verification

Architecture tests reject concrete event implementation types in child
composition factory options and reject a default notifier in
`LarkOutboxDispatcher`. Focused notifier, dispatcher, runtime integration, and
architecture tests run before the full typecheck, build, and Vitest suite.

## Non-goals

- Replacing existing event implementations.
- Passing the whole `RuntimeEventIntegration` object into every child graph.
- Moving durable state into an in-process bus.
- Changing delivery retry, safety-scan, or reconciliation timing.
