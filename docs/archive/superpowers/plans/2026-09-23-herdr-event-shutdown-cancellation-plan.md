# Herdr Event Shutdown Cancellation Implementation Plan

## Objective

Propagate the shared shutdown deadline into the Herdr event path as cooperative
cancellation while preserving true drain settlement as the SQLite ownership
gate.

## Work packages

### 1. Characterize subscriber cancellation

- Add a blocked callback with a queued hint.
- Start `drainEvents(context)`, abort the context, and prove the active callback
  still blocks settlement.
- Release the active callback and prove the queued hint is discarded.
- Preserve no-context `stop()` behavior.

### 2. Add router cancellation checkpoints

- Extend `handle(hint, signal?)` and the composition integration seam.
- Add tests that an already-aborted signal starts no route work.
- Add a test that abort between binding reconciliation and Primary observation
  skips only the not-yet-started observation.
- Keep already-started independent branches in the awaited callback promise.

### 3. Wire the shared shutdown context

- Pass the event-lifecycle signal from subscriber callbacks to
  `RuntimeEventIntegration`.
- Pass `ShutdownContext` into the managed `herdrSocketEventDrain` cleanup.
- Forward context abort into the subscriber controller only while draining and
  remove listeners deterministically.
- Keep the drain writer classification and ingress-first ordering unchanged.

### 4. Document and verify

- Document cancellation as cooperative and settlement-preserving.
- Run focused subscriber, router, integration, shutdown, and managed-runtime
  tests.
- Run typecheck, build, full tests, architecture check, docs audit, public audit,
  and diff check.
- Review independently against repository standards and this design.

### 5. Archive and commit

- Resolve findings and repeat affected checks.
- Archive the completed design and plan.
- Commit the implementation and inspect the final message for unwanted trailers.
