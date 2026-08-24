# High-Reliability Concurrency Implementation Plan

## 1. Lock concurrent coordinator loops

- Replace the reconciliation promise set with one shared in-flight promise.
- Add one shared inbound-drain promise.
- Make shutdown await both owners.
- Add integration tests for concurrent calls and ordered acceptance.

## 2. Order projections by binding

- Replace the global active-handler set with per-binding promise tails.
- Return each event's own result while keeping a non-poisoned continuation tail.
- Remove a tail only when it is still the current tail for that binding.
- Test same-binding ordering, failure recovery, and cross-binding concurrency.

## 3. Fence application writes

- Add `activateWriteFence` and `deactivateWriteFence` to the store interface.
- Expose the held owner/token pair from `InstanceLeaseController`.
- Install connection-local temporary SQLite triggers for every application-state
  table. Each trigger rejects writes unless the durable lease owner/token still
  match and the lease remains unexpired.
- Exclude `instance_lease` and migration metadata from the fence.
- Activate the fence immediately after acquisition and deactivate it only after
  application writers have stopped.
- Test takeover rejection across representative binding, prompt, view, inbound,
  outbox, and audit writes.

## 4. Verify and deploy

- Run focused tests after each slice.
- Run the full Vitest suite, TypeScript typecheck, build, and `git diff --check`.
- Commit only source, tests, and plan files; never stage `var/`.
- Restart the PM2 process and verify `/ready`, `/status`, Lark readiness, lease
  ownership, and bounded restart behavior.
