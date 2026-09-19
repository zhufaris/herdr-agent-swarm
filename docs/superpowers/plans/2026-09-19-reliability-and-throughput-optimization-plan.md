# Reliability and Throughput Optimization Implementation Plan

**Goal:** Implement the approved B+C optimization design as four reversible
workstreams while preserving SQLite authority, exact-turn no-replay, independent
Primary/Worker writers, ordered durable delivery, and local-only approval.

**Design:** `docs/superpowers/specs/2026-09-19-reliability-and-throughput-optimization-design.md`

## Execution rules

- Work test-first at every changed boundary.
- Commit each numbered slice independently after its focused tests pass.
- Do not install, restart, or push as part of implementation. Installation is a
  later operator action; force restart always requires fresh authorization.
- Do not run build concurrently with installer/lifecycle tests because build
  atomically replaces `dist/`.
- Add no payload-bearing in-memory queue and no shared Primary/Worker executor.

## Workstream 1: correctness and startup recovery

### Task 1: Close the reconciliation completion race

**Files:**

- Modify `tests/priority-reconciliation-runner.test.ts`.
- Modify `src/runtime/priority-reconciliation-runner.ts`.

**Steps:**

1. Add a regression in which the first request's promise continuation
   synchronously submits a second request after the drain has observed no more
   pending work but before active cleanup. Prove the second request completes
   without a timer or third request.
2. Add assertions for one active executor, preserved priority order, failure
   continuation, and stop behavior.
3. Clear `active` in one completion owner, then restart the drain whenever
   bounded pending state remains and stopping has not begun.
4. Run `npx vitest run tests/priority-reconciliation-runner.test.ts` and
   `npm run typecheck`. Commit as a correctness fix.

### Task 2: Invalidate cache on full Herdr uncertainty

**Files:**

- Modify `src/runtime/workspace-snapshot-cache.ts`.
- Modify `src/runtime/herdr-event-router.ts`.
- Modify `tests/workspace-snapshot-cache.test.ts`.
- Modify `tests/herdr-event-router.test.ts`.

**Steps:**

1. Add a full invalidation API backed by the existing generation fence.
2. Prove a cached/in-flight snapshot cannot publish after full invalidation.
3. Invoke full invalidation before full-scope consumers.
4. Prove both Primary and Worker consumers observe the newer generation.
5. Run the two focused tests and typecheck. Commit independently.

### Task 3: Put durable repair before publisher claims

**Files:**

- Modify `src/coordinator/startup-recovery-workflow.ts`.
- Modify `src/composition/managed-bridge-runtime.ts`.
- Modify the corresponding composition/runtime types as required.
- Modify `tests/startup-recovery-workflow.test.ts` and managed-runtime startup
  tests.

**Steps:**

1. Split startup into an idempotent pre-delivery repair phase and a
   post-publisher runtime phase.
2. Keep legacy cleanup, quarantine reconciliation, obsolete-intent retirement,
   and startup projection reservation in pre-delivery repair.
3. Start the publisher only after pre-delivery repair resolves successfully.
4. Start runtime baselines, Herdr observers, and periodic work afterward.
5. Test that a stale unclaimed intent is retired before a publisher can claim
   it, while claimed/attempted/uncertain intents remain immutable.
6. Run startup, outbox recovery, publisher, and no-replay focused suites plus
   typecheck. Commit independently.

### Task 4: Give failed startup views a retry owner

**Files:**

- Modify `src/coordinator/startup-view-converger.ts`.
- Add `src/coordinator/startup-view-recovery.ts`.
- Wire it through composition and health diagnostics.
- Modify `tests/startup-view-converger.test.ts`; add a focused recovery test.
- Modify health/readiness tests.

**Steps:**

1. Return failed binding IDs while preserving per-binding isolation.
2. Add a single-flight, bounded-ID retry component with capped exponential
   backoff and clean shutdown. It reconstructs all state from SQLite.
3. Expose pending/retry/recovery/last-failure diagnostics and degrade readiness
   while known obligations remain.
4. Test failure isolation, de-duplication, backoff, successful removal, restart
   rediscovery, status visibility, and shutdown.
5. Run focused startup and health tests plus typecheck. Commit independently.

## Workstream 2: real-time hot paths

### Task 5: Batch targeted Primary snapshots

**Files:**

- Extend the narrow Herdr observation port and `src/adapters/herdr-adapter.ts`.
- Modify `src/coordinator/herdr-runtime-reconciler.ts`.
- Modify `tests/herdr-adapter.test.ts` and
  `tests/herdr-runtime-reconciler.test.ts`.

**Steps:**

1. Add an adapter operation returning normalized observations for a bounded pane
   batch from one fresh snapshot.
2. Index the immutable result locally by pane ID.
3. Bound only unavoidable extra foreground probes.
4. Test one snapshot for multiple pane IDs, missing panes, probe bounds, and
   unchanged lifecycle eligibility. Commit after focused tests and typecheck.

### Task 6: Batch pane-retention scans

**Files:**

- Modify `src/coordinator/pane-retention-workflow.ts`.
- Modify its composition port and focused tests.

**Steps:**

1. Read one fresh bulk snapshot per retention pass.
2. Select candidates from an indexed local view.
3. Preserve one final targeted fresh observation immediately before close.
4. Test snapshot call counts and changed/absent pane safety fences. Commit.

### Task 7: Reuse the Answer page computation

**Files:**

- Modify `src/domain/answer-page-plan.ts`.
- Modify `src/coordinator/answer-page-workflow.ts`.
- Modify `src/runtime/answer-stream.ts`.
- Modify Answer page, stream, Markdown, and projector tests.

**Steps:**

1. Make the plan carry rendered content, canonical source bounds, overflow, and
   continuation metadata.
2. Remove the workflow's second render.
3. Compute the suffix-adjusted limit before the paginator so overflow calls it
   once.
4. Instrument call counts in tests and preserve code-fence/protected-range,
   suffix, canonical offset, frozen-page, and 9,000-character behavior.
5. Run all Answer/rendering focused suites and typecheck. Commit independently.

## Workstream 3: bounded resources and durable queries

### Task 8: Bound process-local lifecycle state

**Files:**

- Modify `src/runtime/herdr-socket-subscriber.ts` and tests.
- Modify `src/coordinator/swarm-command-gateway.ts` and tests.

**Steps:**

1. Replace subscribed pane IDs from every authoritative reconnect snapshot and
   clear them on stop.
2. Retain Worker creation results only for card/Primary-tool synchronous
   consumers; message commands leave no entry after durable reply completion.
3. Test missed-close reconnect, stop cleanup, and all three Worker creation
   entry points. Commit independently.

### Task 9: Bound external-turn scan concurrency

**Files:**

- Modify `src/coordinator/external-turn-observer.ts`.
- Modify its focused/integration tests and diagnostics types if needed.

**Steps:**

1. Add a small worker pool over active bindings.
2. Retain the current per-binding serialization fence.
3. Test global maximum concurrency, same-binding serialization, failure
   isolation, and clean shutdown. Commit independently.

### Task 10: Optimize normalized continuation and startup selection queries

**Files:**

- Modify `src/store/sqlite/outbox-queue-store.ts`.
- Modify `src/store/sqlite/inbound-project-store.ts`.
- Add an additive migration only if query-plan evidence requires an index.
- Modify `tests/sqlite-store.test.ts` and startup recovery tests.

**Steps:**

1. Replace continuation JSON extraction with `stream_page_index`.
2. Inspect `EXPLAIN QUERY PLAN`; add a partial composite index only when needed.
3. Filter completed project selections with durable `NOT EXISTS` against the
   deterministic prompt message ID.
4. Prove lifetime historical rows do not change outstanding recovery results and
   retain the unique constraint as final fence. Commit independently.

### Task 11: Add a bounded startup view read model

**Files:**

- Extend the startup recovery store port.
- Modify `src/store/sqlite/projection-store.ts` and related capability wiring.
- Modify `src/coordinator/startup-view-converger.ts`.
- Modify store and startup convergence tests.

**Steps:**

1. Express durable predicates for unfinished lifecycle, actionable Answer pages,
   undelivered revisions, recovery rows, and relevant pending outbox work.
2. Return only candidate binding IDs and batch stable related reads where it
   keeps transaction ownership intact.
3. Keep projection reservation in existing workflows.
4. Test each inclusion predicate and exclusion of historical complete rows.
5. Inspect the query plan and commit after focused tests/typecheck.

### Task 12: Bound `/sessions` with stable pagination

**Files:**

- Add an additive binding index migration.
- Modify `src/store/sqlite/binding-store.ts`.
- Modify operations query/card command contracts as needed.
- Modify store, operations, command parser, and card tests.

**Steps:**

1. Add a `chat_id`-leading index aligned with the query.
2. Introduce a fixed first-page limit and opaque/stable keyset over the complete
   lifecycle/runtime/activity/ID sort tuple.
3. Preserve existing first-page usefulness and add explicit continuation.
4. Test stable non-overlapping pages, ties, inserted rows, invalid cursors, and
   the actual query plan. Commit independently.

### Task 13: Use fixed-size outbound idempotency material

**Files:**

- Modify the affected card-reservation workflows.
- Modify `src/events/outbound-intent-writer.ts` if serialization ownership moves.
- Modify idempotency/outbox tests.

**Steps:**

1. Inventory every key containing serialized card JSON.
2. Prefer semantic view revision where present; otherwise serialize once and use
   a SHA-256 digest.
3. Prove identical content is idempotent, changed content differs, restart is
   deterministic, and existing rows need no migration. Commit independently.

### Task 14: Coalesce `/status` work

**Files:**

- Modify `src/health/server.ts` and focused tests.
- Add a small runtime coalescer module only if it keeps the server focused.

**Steps:**

1. Restrict read endpoints to GET/HEAD.
2. Share one in-flight status collection and cache success for a short fixed TTL.
3. Do not cache failure as healthy and do not derive readiness from status cache.
4. Test concurrent requests, expiry, retry after failure, method rejection, and
   unchanged loopback binding. Commit independently.

## Workstream 4: operations and simplification

### Task 15: Add safe active-service log rotation

**Files:**

- Modify `src/main.ts` to create/reopen the installed Pino destination.
- Modify `src/cli/service-lifecycle.ts` and systemd unit generation.
- Add the user timer/service lifecycle surface and tests.
- Modify `tests/service-lifecycle.test.ts` and logging tests.
- Update operations documentation.

**Steps:**

1. Keep foreground logging on stdout; installed mode receives an explicit private
   log path and opens one Pino destination.
2. Reserve `SIGUSR2` for destination reopen and keep SIGINT/SIGTERM shutdown.
3. Implement locked, no-follow, regular-file-validated rotation at 16 MiB with
   exactly one retained `.1`.
4. Resolve exact systemd MainPID, fail closed on ownership mismatch, rename/create,
   signal, and verify reopen. Never create a second writer or restart the service.
5. Test active rotation, 0600/0700 permissions, symlink/hard-link rejection, wrong
   PID, failed signal/reopen recovery, one writer, and bounded `swarm:logs`.
6. Run lifecycle/logging tests and typecheck. Commit independently.

### Task 16: Gate recurring reconciliation warnings

**Files:**

- Modify `src/coordinator/herdr-snapshot-collector.ts`.
- Modify `src/coordinator/herdr-runtime-reconciler.ts`.
- Reuse `FailureLogGate`; modify focused tests.

**Steps:**

1. Assign stable scope/signatures to snapshot, probe, binding, and reconciliation
   failures.
2. Emit first failure, bounded aggregate reminders, and one recovery record.
3. Test repeated failure volume and recovery without logging payload text. Commit.

### Task 17: Avoid redundant immutable-release staging

**Files:**

- Modify `scripts/stage-production-runtime.sh`.
- Modify installer/staging tests.

**Steps:**

1. Validate an existing direct immutable release and matching build identity before
   creating staging or invoking npm.
2. Retain the post-stage existence race fence for concurrent first installers.
3. Test exact-hit zero copy/npm, invalid/mismatched release failure, and concurrent
   first stage. Commit independently.

### Task 18: Reduce lifecycle readiness polling work

**Files:**

- Modify `src/cli/service-lifecycle.ts`.
- Modify `tests/service-lifecycle.test.ts`.

**Steps:**

1. Fetch activity and MainPID in one systemd sample.
2. Poll HTTP without an `ss` scan until the expected build is observed.
3. Check listener ownership only for matching candidates and retain the second
   matching sample.
4. Test command counts plus wrong PID/build/listener fail-closed behavior. Commit.

### Task 19: Bound reconciliation configuration

**Files:**

- Modify `src/config.ts`, environment examples/docs, and `tests/config.test.ts`.

**Steps:**

1. Add explicit safe lower/upper bounds while retaining the default.
2. Test both boundaries and rejection outside them. Commit independently.

### Task 20: Remove proven redundancy

**Files:**

- Remove dead progress helpers and compiler-confirmed unused declarations.
- Extract common agent-driver name/MCP argument helpers.
- Simplify `ProjectCatalog` and directory grouping with local mutable buckets/sets.
- Remove repository-unreferenced exports only after a fresh exact-name search.
- Modify focused driver/catalog/card tests where behavior is covered.

**Steps:**

1. Run strict unused checks and exact-name repository searches before edits.
2. Make mechanical changes without changing strings, arguments, or ordering.
3. Run focused tests, strict unused checks, and typecheck. Commit separately from
   behavioral work.

## Final validation and completion audit

1. Run focused suites named in every task and preserve their output.
2. Run sequentially: `npm test`, `npm run typecheck`,
   `npm run architecture:check`, `npm run docs:audit`, `npm run build`, and
   `git diff --check`.
3. Map all ten design goals, all invariants, and all eighteen verification-matrix
   checks to concrete tests, source evidence, query plans, or lifecycle fixtures.
4. Inspect Git status, every new commit, and the complete outgoing range. Confirm
   no installation, restart, or push occurred.
5. Record the hook-injected `Co-authored-by: TRAE CLI` trailers as a blocking
   cleanup requirement before any future push, then run `npm run public:audit` if
   and only if a push is requested.
