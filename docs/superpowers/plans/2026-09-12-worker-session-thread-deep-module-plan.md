# Worker Session Thread Deep-Module Refactor Implementation Plan

**Goal:** Concentrate Worker Session Thread routing, publication, placement, and
delivery settlement behind deep application and SQLite modules without changing
deployed schema or user-visible behavior.

**Architecture:** Introduce `WorkerSessionThreadWorkflow` as the only application
entry for thread messages and publication callbacks. Deepen
`SqliteWorkerSessionThreadStore` so callers consume tagged semantic outcomes
instead of rows and lifecycle states. Keep migrations 35/36 and all durable
identities unchanged.

## Task 1: Define consumer-shaped interfaces

- Add a dedicated Worker Thread port with tagged scope, publication, projection,
  settlement, and retirement outcomes.
- Keep raw `WorkerSessionThread` rows internal to the SQLite adapter.
- Add interface-level tests for none/active/stale resolution and publication
  decisions before migrating callers.

## Task 2: Deepen SQLite thread persistence

- Replace separate active/historical queries with one `resolveScope` operation.
- Add `reserveLegacyEntry`, `reserveCanonicalMain`, `settlePublication`, and
  `retireSession` operations.
- Keep publication ACK and outbox settlement inside the existing outer SQLite
  transaction.
- Preserve outbox keys, lanes, claims, schema rows, and no-replay behavior.

## Task 3: Introduce the application workflow

- Move thread-local command parsing, authorization, fixed-session routing,
  feedback cards, and legacy publication feedback into
  `WorkerSessionThreadWorkflow`.
- Make `InboundMessageRoutingWorkflow` call one `handleMessage` entry and consume
  only its handled/disposition result.
- Make `InstanceInteractionWorkflow` delegate `worker_thread_send` to the new
  workflow and remove thread-specific implementation.

## Task 4: Move projection and ACK policies behind the SQLite module

- Replace `SqliteCardContextStore` canonical/legacy branching with one
  `reserveCanonicalMain` call.
- Replace direct `worker_session_threads` SQL in `SqliteOutboxDeliveryStore` with
  `settlePublication`.
- Route Worker termination and removal through `retireSession`.

## Task 5: Contract broad ports and tests

- Remove Worker Thread persistence methods from `InstanceStore` and
  `InboundRoutingStore`.
- Expose one dedicated capability from `SqliteStoreBundle`.
- Replace tests that mock internal lookup sequences with workflow-interface tests
  and dedicated temporary-SQLite adapter tests.
- Retain a small integration set for ingress, card context, outbox, and restart
  recovery wiring.

## Task 6: Verification

- Run Worker Thread workflow, instance routing, card action, card context, SQLite,
  outbox dispatcher, lifecycle, and concurrency suites.
- Run `npm run typecheck`, `npm run build`, `npm test`, architecture checks, and
  `git diff --check`.
- Do not commit, install, restart, tag, publish, push, or perform live Lark writes
  without a separate explicit request.
