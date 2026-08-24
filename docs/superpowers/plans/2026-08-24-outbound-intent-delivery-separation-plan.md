# Outbound Intent and Delivery Separation Plan

## Goal

Make outbound intent persistence independent from Lark network delivery while
preserving lane ordering, retries, and the initial Answer Card dispatch gate.

## Slices

- [x] Add a coalescing `OutboundWorkNotifier` and test duplicate/lost wake
  behavior through its public interface.
- [x] Extract `OutboundIntentWriter`; prove enqueue returns after SQLite commit
  while a Lark request is blocked.
- [x] Convert `LarkOutboxDispatcher` into a notifier-driven delivery worker with
  startup scan, retry timer, safety scan, and bounded shutdown.
- [x] Split delivery-checkpoint subscription from `OutboundIntentPort` and wire
  both modules in the composition root and test fixture.
- [x] Remove normal workflow `drain()` dependencies, retaining explicit durable
  outbox wake after store operations that atomically create intent.
- [x] Prove initial Answer Card delivery still gates TraeX dispatch and explicit
  dead-letter retry no longer waits for delivery.
- [x] Update architecture documentation and run focused tests, full tests,
  typecheck, production build, and diff validation.
- [x] Commit without restarting or deploying the managed service.

## Test seams

- `OutboundWorkNotifier`: coalesced best-effort notification.
- `OutboundIntentPort`: durable enqueue completion independent of transport.
- `OutboxDispatcherControl`: startup scan, wake-driven delivery, retry, safety
  convergence, and shutdown.
- `InboundRouter`: durable inbound acceptance without Lark delivery latency.
- `PromptRunWorkflow`: no TraeX dispatch before Answer Card checkpoint.
