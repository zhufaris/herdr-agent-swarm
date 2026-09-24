# Runtime Event Bus and Steer Dispatch Implementation Plan

## Objective

Unify process-local event infrastructure behind `RuntimeEventBus`, preserve the
four reliability classes through narrow ports, and dispatch durable active-turn
control outside inbound request handlers without weakening exact-turn fencing or
no-replay recovery.

## Work packages

### 1. Characterize and introduce the event engine

- Add a closed runtime event map, common metadata envelope, key policy, and
  per-channel delivery policy.
- Add one named-subscriber engine for awaited fan-out and coalesced hints.
- Cover duplicate names, error isolation, startup buffering, sealing, and
  content-safe diagnostics.

### 2. Adapt existing narrow ports

- Rebuild lifecycle, inbound, prompt, outbound, and instance wake-up ports as
  adapters over the shared engine.
- Keep consumers dependent on capability-focused interfaces.
- Replace `WorkWakeupHub` and separate listener collections once equivalent
  behavior is covered.

### 3. Extract steer dispatch

- Split durable validation/acceptance from native effect execution.
- Add owner-scoped dispatcher drains and startup recovery.
- Publish only owner identity in work envelopes; reload operation data from
  SQLite before claim and effect.
- Preserve idle priority conversion, duplicate handling, result cards, exact-turn
  fences, and uncertain-after-dispatch semantics.

### 4. Composition, status, and documentation

- Wire the dispatcher and bus lifecycle in startup/shutdown order.
- Expose per-channel diagnostics without sensitive payloads.
- Update architecture text and boundary tests; remove superseded shallow event
  infrastructure.

### 5. Verification

- Run focused runtime-event, turn-control, recovery, status, composition, and
  architecture tests.
- Run `npm run docs:audit`, `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, `git diff --check`, and `npm test`.
- Audit the final diff against every invariant in the design before marking the
  EventBus boundary complete.
