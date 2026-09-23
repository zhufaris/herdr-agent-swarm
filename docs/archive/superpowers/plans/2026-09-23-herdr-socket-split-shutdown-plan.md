# Herdr Socket Split Shutdown Implementation Plan

Status: completed and verified on 2026-09-23.

## Objective

Expose an explicit socket ingress gate and event-drain barrier, wire both into
the managed lifecycle in dependency-safe order, and retain SQLite ownership for
every unsafe drain outcome.

## Work packages

### 1. Characterize the subscriber seam

- Add a test with a blocked first event callback and a queued second hint.
- Assert `stopIngress()` returns without waiting for the callback.
- Assert a post-gate hint is ignored.
- Assert `drainEvents()` remains pending until both admitted hints complete.
- Keep the existing combined `stop()` test as compatibility coverage.

### 2. Implement the split lifecycle API

- Extract synchronous ingress gating and resource teardown from `stop()` into
  idempotent `stopIngress()`.
- Add `drainEvents()` to await the active `hintDrain`.
- Implement `stop()` as `stopIngress()` followed by `drainEvents()`.
- Do not change `emit()`, `drainHints()`, merge rules, or event error handling.

### 3. Wire dependency-safe managed shutdown

- Extend the managed dependency interface with `stopIngress()` and
  `drainEvents()`.
- Register `herdrSocketEventDrain` first as an ingress-stage writer and
  `herdrSocketIngress` second as an ingress-stage non-writer so reverse
  registration order closes ingress before waiting for the drain.
- Update runtime fixtures and tests to assert close-before-drain and
  drain-before-dependent cleanup ordering.
- Update failure and timeout expectations to report
  `herdrSocketEventDrain` and retain ownership.

### 4. Synchronize documentation and verify

- Update `docs/architecture.md` with the explicit two-step lifecycle and its
  sequential dependency constraint.
- Run focused subscriber, shutdown, lifecycle-ledger, and managed-runtime tests.
- Run typecheck, build, full tests, architecture check, docs audit, public audit,
  and diff check.
- Review independently against repository standards and this design.

### 5. Archive and commit

- Resolve review findings and repeat affected checks.
- Move the completed design and plan into `docs/archive/superpowers/`.
- Commit documentation and implementation in focused commits, inspect their
  messages, and remove any automatically injected assistant co-author trailer.
