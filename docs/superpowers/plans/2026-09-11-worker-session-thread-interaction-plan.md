# Worker Session Thread Interaction Implementation Plan

**Goal:** Give each Worker Session generation one durable Lark thread whose
ordinary messages create FIFO Worker turns, while preserving exact-turn control,
one live Worker Main Card, and no-replay delivery behavior.

**Architecture:** Add a dedicated `worker_session_threads` routing aggregate. New
Worker Sessions reserve their sole Worker Main Card with `group_card_create`;
already-delivered sessions can opt into a passive legacy entry root. Resolve the
thread before mutable instance targets, then delegate work and exact-turn control
to existing instance workflows.

## Task 1: Define thread identity and persistence contracts

- Add `WorkerSessionThread` domain types with `canonical-main | legacy-entry`
  mode and `reserving | active | stale` lifecycle.
- Extend instance/outbox ports with exact-session reserve, lookup, activation,
  and staleness operations; do not expose raw SQL across capability boundaries.
- Add failing store tests for uniqueness, generation/pane/parent fences, active
  root lookup, duplicate reservation, and lease ownership.
- Add schema migration after the current highest migration. The table references
  Worker and Binding identities, has unique nullable topic/root identifiers, and
  is included in integrity and retention checks.

## Task 2: Generalize durable group-root delivery

- Extend outbound identity with a `workerThreadId` discriminator while preserving
  the existing Primary `threadAliasId` path. Exactly one group-create target kind
  is legal per row.
- Update delivery intent materialization, claim freezing, lane selection, target
  validation, SQLite records, and migration rebuild constraints.
- On Worker canonical delivery ACK, atomically activate the thread, checkpoint
  the Worker Main message/card identity, advance delivered version, record the
  bridge message, and settle the outbox claim.
- On legacy-entry ACK, activate only the routing row; never mutate the canonical
  Worker Main target or version.
- Add executor/store tests for retry, duplicate ACK, stale claim, uncertain
  checkpoint, and no duplicate group create.

## Task 3: Select canonical versus legacy placement safely

- In Worker card-context convergence, resolve or reserve the placement before
  creating the first visible Worker Main Card.
- New sessions created after migration reserve a canonical group root. Migration
  writes a `legacy-unpublished` marker for every already persisted active Worker,
  so existing message targets and any claimed, attempted, checkpointed,
  delivered, dead-lettered, or uncertain creates remain legacy without inference.
- Do not perform Lark writes during migration or startup classification. Preserve
  attempted effects and the Worker no-replay invariant.
- Keep later Worker Main updates on the existing session lane and target only the
  confirmed canonical message. A reserving root defers visual updates without
  delaying Worker execution.
- Add startup/migration tests for pristine, delivered, claimed, attempted,
  dead-lettered, and uncertain placement cases.

## Task 4: Add the legacy entry action and passive card

- Add `发送 Worker 卡片到群` to the instance directory/detail view with Worker,
  session generation, parent Binding generation/pane, source Main message, and
  conversation fences.
- Implement one transactional reservation workflow that returns `sent`,
  `duplicate`, `pending`, or `stale` without calling Lark directly.
- Render a passive snapshot for legacy placement. It must not contain live
  steer/stop/new-task callbacks or advance `WorkerMainView.deliveredVersion`.
- Repeated action for an active or reserving thread creates no additional outbox
  row. Add card-action, renderer, and store tests.

## Task 5: Route Worker thread messages before mutable targets

- Add exact chat/topic/root lookup to the inbound routing store and resolve
  Worker threads before global instance commands and Primary Binding routing.
  Historical Task Card replies retain the current single-card migration behavior
  and are not revived as a separate routing authority.
- Add thread-local parsing for `/status`, `/steer <text>`, and `/stop`; keep the
  existing named forms unchanged outside Worker threads. Reject other slash
  commands in a Worker thread instead of treating them as prompts or falling
  through to Primary.
- Route ordinary text to `InstanceMessagingWorkflow.submit` using the fixed
  Worker ID and inbound root. It always creates an independent FIFO turn.
- Route `/steer` and `/stop` through fresh exact-active-turn resolution and the
  existing durable control operations. Never downgrade either action to new
  queued work.
- Render `/status` as a passive snapshot in the same thread. Add precedence,
  authorization, duplicate inbound, stale generation, and selected-target
  isolation tests.

## Task 6: Converge lifecycle, integrity, and operations

- Mark or treat a thread stale when its Worker Session terminates, the parent
  Binding changes generation/lifecycle/attachment, or the owning pane changes.
- Include thread counts and delivery states in bounded status diagnostics and
  structured logs without prompt/card payloads.
- Protect active/reserving thread rows and referenced outbox work from premature
  retention. Add integrity checks for target-kind exclusivity and parent/session
  consistency.
- Update architecture, Feishu usage, release notes, and TODO only after behavior
  is proven.

## Task 7: Verification and handoff

- Run focused domain, command parsing, instance routing/messaging, Worker Main,
  card action, SQLite migration/store, delivery executor/recovery, retention,
  concurrency, reconciliation, and shutdown tests.
- Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- Inspect all group-create rows for immutable target identity and all message paths
  for generation/pane/parent fences.
- Do not commit, install, restart, tag, publish, push, or perform live Lark writes
  without a separate explicit request.
