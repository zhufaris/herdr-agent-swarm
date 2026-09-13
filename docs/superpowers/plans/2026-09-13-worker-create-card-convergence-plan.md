# Worker Create Card Convergence Implementation Plan

**Goal:** Turn a successful `/instances` Worker form submission into one promptly
reserved, durable canonical Worker Main thread.

## Task 1: Lock callback-to-projection behavior

- Add an integration test using the real SQLite store, shared outbound notifier,
  and `CardContextRebuilder`.
- Submit the Worker creation form and assert one Worker plus one canonical
  `worker-main:create` group-card intent.
- Assert duplicate submission does not duplicate either aggregate.
- Add a start-failed case that still wakes and projects current failure state.

## Task 2: Trigger the existing durable projection path

- Call the existing `wakeOutbound` callback only after creation returns a durable
  Worker result.
- Keep the callback detail card as immediate UI feedback.
- Do not call Gateway APIs or `reserveCanonicalMain()` directly from the handler.

## Task 3: Verify and commit

- Run instance routing, command gateway, card-context, Worker thread, and outbox
  dispatcher tests.
- Run typecheck, build, architecture checks, full tests, and diff checks.
- Commit independently; do not install or restart production in this slice.
