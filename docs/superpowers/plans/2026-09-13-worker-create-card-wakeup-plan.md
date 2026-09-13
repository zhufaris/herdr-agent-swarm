# Worker Creation Card Wake-Up Implementation Plan

**Goal:** Wake the existing durable card-context pipeline after a Worker is
created from `/instances`, so its canonical Worker Main Card is promptly created.

## Task 1: Lock callback wake behavior

- Add form-submit tests for created, start-failed, invalid, and unauthorized
  outcomes.
- Assert successful persisted outcomes wake exactly once and rejected input does
  not wake.

## Task 2: Prove end-to-end durable convergence

- Connect a real SQLite store, `InProcessOutboundWorkNotifier`, and
  `CardContextRebuilder` in an integration test.
- Create a Worker through the CardKit callback path.
- Assert exactly one canonical `worker-main:create` group-card intent is reserved.
- Repeat the callback and scan to prove Worker/card idempotency.

## Task 3: Implement and verify

- Emit the existing wake only after a durable Worker result is returned.
- Preserve the immediate detail-card response and all command-intent semantics.
- Run instance routing, command gateway, card-context, Worker thread, outbox,
  typecheck, build, architecture checks, and the full suite.
- Commit independently; do not install or restart production.
