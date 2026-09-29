# Durable Outbound Delivery Implementation Plan

## Objective

Implement the approved outbound seam while preserving every durable delivery and
checkpoint behavior.

## Step 1: Characterize lane draining

Add `tests/outbound-lane-drain.test.ts` with a tracer test for independent-lane
concurrency and failed-lane blocking through the public drain interface.

## Step 2: Add consumer-shaped ports

Add `OutboundScanStore` and `OutboundDeliveryStore` to
`src/domain/ports/outbox.ts`. Update dispatcher, lane drain, executor, and intent
materialization signatures without changing the SQLite capability adapter.

## Step 3: Extract the lane engine

Create `src/events/outbound-lane-drain.ts`. Move selection, fairness, concurrency,
duplicate-attempt, fatal checkpoint, and scan metrics logic out of
`GatewayOutboxDispatcher`. Keep scan lifecycle, retry scheduling, diagnostics,
subscriptions, and shutdown in the facade.

## Step 4: Enforce and document the seam

Update architecture tests and docs. Assert that the facade delegates draining,
the lane engine does not know notifier/timer lifecycle, and the executor consumes
only `OutboundDeliveryStore`.

## Step 5: Verify

Run the lane tracer, complete outbox dispatcher suite, architecture tests,
typecheck, build, architecture check, docs audit, full tests, and `git diff --check`.
Commit design, plan, and implementation separately; do not install, restart, or
push.
