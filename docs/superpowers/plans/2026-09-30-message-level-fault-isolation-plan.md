# Message-Level Fault Isolation Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Prevent one malformed Core event, missing native turn index entry, or failed
Feishu update from blocking later message projection, Prompt FIFO progress, or
independent CardKit delivery lanes.

**Architecture:** Extend the existing Core event inbox and Gateway outbox with
per-event settlement, Core-owned historical turn-index recovery, durable recovery
backoff, projection gaps, and canonical snapshot compensation. Agent execution,
projection, and delivery remain independent durable state machines. No recovery
path reads JSONL in Swarm or replays a possibly dispatched Prompt.

**Spec:** `docs/superpowers/specs/2026-09-30-message-level-fault-isolation-design.md`

**Builds on:**
`docs/superpowers/plans/2026-09-30-core-event-recovery-and-nonblocking-projection-plan.md`

**Verified implementation status (2026-09-30):** Per-event Core projection
settlement, three-attempt reducer-revision quarantine, owner-scoped projection
gaps, Main/Answer/Worker aggregate warnings, evidence-based compensation,
expired Answer-target replacement on a new static CardKit page, and
acknowledgement-safe rollback of in-memory Core reducer state, atomic Core
projection mutation and inbox settlement, and the Swarm-side typed historical
turn recovery/backoff/terminalization path are implemented. Swarm verification
passes 225 test files / 3,043 tests, TypeScript typecheck, build, and
`git diff --check`. The independent Core historical-index verification gate and
the live acceptance test remain open below.

## Constraints

- Preserve Core, Swarm, and Feishu as separate authorities.
- Swarm consumes typed Herdr Core APIs only; it never reads Agent JSONL.
- Recovery requires exact Agent kind, session, transcript/file identity, native
  turn identity, canonical start time, and validated checkpoint order.
- Never use text matching, approximate time matching, or UUID timestamp
  inference.
- Never replay a Prompt that may have reached TraeX or Pi.
- Never automatically skip an Agent whose current state is `blocked`.
- Projection and delivery failures do not control Agent execution state.
- Frozen Answer pages remain immutable.
- Preserve unrelated dirty-worktree changes in both repositories.
- Use formal store APIs and migrations; do not repair production state with raw
  SQL.
- Do not install or restart until both repositories pass their verification
  gates and an immutable release is staged.

## Task 1: Lock down the current hot-loop regression

**Repository:** `/workspace/herdr-agent-swarm`

**Files:**

- Modify: `tests/external-turn-observer.test.ts`
- Modify: `tests/herdr-events-reader.test.ts`
- Modify: `tests/prompt-run-safety-scan.test.ts`

- [x] Add a deterministic fixture where a persisted Herdr-origin Prompt carries
  an exact native turn ID that is absent from Core's current index and recovery
  returns `turn_not_found`.
- [ ] Assert repeated observer scans do not reopen the same recovery command
  before a durable retry deadline.
- [ ] Assert no Prompt dispatch, terminal input, or Agent replay occurs.
- [ ] Assert a later independent binding and a later safely eligible FIFO item
  can still progress.
- [x] Run the focused test and retain the expected red failure before changing
  production code.

## Task 2: Restore complete native turn-index coverage in Herdr Core

**Repository:** `/tmp/herdr-core-native-goal-lifecycle`

**Files:**

- Modify: `src/agent_events/journal.rs`
- Modify: `src/agent_events/source.rs`
- Modify: `src/api/schema/agent_events.rs`
- Modify: `src/api/schema.rs`
- Modify: `src/api/schema/response.rs`
- Modify: `src/api/server/agent_events.rs`
- Modify: `src/api/server.rs`
- Modify: `src/cli/agent_events.rs`
- Regenerate: `docs/next/api/herdr-api.schema.json`
- Test: adjacent codec, journal, API, schema, and CLI tests

- [ ] Reproduce a source/PID rotation where a canonical transcript contains a
  completed native turn outside every live source checkpoint and `recover-turn`
  currently returns `turn_not_found`.
- [ ] Add a separate durable historical-index checkpoint per canonical
  transcript; never rewind a live source cursor or emit historical events into
  its live event stream.
- [ ] Advance historical indexing in bounded batches while validating regular
  file identity, header/session identity, anchors, decoder state, and monotonic
  checkpoints.
- [ ] Persist exact native turn start/end checkpoints in the existing
  `turn_index`, updating source definitions only when canonical transcript
  identity remains equal.
- [ ] Resolve recovery by exact Agent kind, session, and native turn ID; require
  uniqueness before accepting a seconds-only legacy `started_at` fence and
  return the canonical timestamp in the typed result.
- [ ] Return typed incomplete/not-found/ambiguous outcomes without text,
  timestamp-range, UUID-time, or Human-message matching.
- [ ] Prove wrong file, session, Agent kind, changed anchor, incomplete terminal
  boundary, and duplicate native turn IDs fail closed.
- [x] Run focused Rust tests, schema generation, `cargo fmt --check`, and
  `cargo check --locked`. The 40 focused Agent Events tests and adjacent API
  integration test pass; the release build also passes. The repository's full
  supported suite still requires `cargo nextest`, which is not installed on
  this host; plain libtest cannot substitute because its shared process is
  terminated by a headless-server SIGPIPE test that nextest isolates.

## Task 3: Consume canonical native-turn recovery in Swarm

**Repository:** `/workspace/herdr-agent-swarm`

**Files:**

- Modify: `src/domain/ports/external.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Modify: `src/runtime/exact-turn-observer.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/detached-prompt-observer.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Create: `src/store/sqlite/turn-recovery-state-store.ts`
- Modify: store capability/bundle composition files
- Modify: `src/store/sqlite-integrity.ts`
- Test: reader, observer, recovery, SQLite, and capability-graph tests

- [x] Add typed index-recovery capability and response validation; do not parse
  CLI error strings to infer ownership.
- [x] Persist Core's canonical `started_at` only through a generation-, pane-,
  session-, turn-, and old-start-fenced transaction.
- [x] Reopen exact recovery with the unchanged native turn ID and canonical
  start; retain immutable audit evidence for the precision correction.
- [x] Return `indexing`, `not_found`, `ambiguous`, capability unavailable, and
  transient Core failure as distinct domain outcomes.
- [x] Add integrity checks for orphaned recovery state, mismatched Prompt turn
  identity, and cross-session corrections.

## Task 4: Replace hot polling with durable turn-recovery scheduling

**Files:**

- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/detached-prompt-observer.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/store/sqlite/prompt-recovery-store.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: diagnostics/status types and collectors
- Test: observer, concurrency, prompt-safety, startup-recovery, and status tests

- [x] Persist recovery state, attempt count, sanitized error fingerprint,
  `last_recovery_at`, and `next_recovery_at`.
- [x] Exclude future-due recovery rows from ordinary scans.
- [x] Coalesce repeated identical failures and log only first occurrence,
  logarithmic milestones, and state changes.
- [x] Keep `working`, `blocked`, and transient-Core cases uncertain with bounded
  backoff; `blocked` is never auto-skipped.
- [x] When the pane is freshly proven idle/done and complete Core evidence still
  cannot resolve the old Prompt, atomically terminalize it as uncertain, reserve
  its warning projection, append audit evidence, and wake the next FIFO item.
- [x] When a strictly newer native turn is proven, adopt it without replay and
  settle the older detached Prompt as uncertain.
- [x] Prove `/health` remains responsive under repeated recovery failures.

## Task 5: Split Core observation into per-event settlement

**Files:**

- Modify: `src/domain/core-event-inbox.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Modify: `src/runtime/exact-turn-observer.ts`
- Modify: `src/coordinator/transcript-observer.ts`
- Modify: `src/coordinator/owned-transcript-output-projector.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/worker-turn-observer.ts`
- Modify: `src/store/sqlite/core-event-inbox-store.ts`
- Test: `tests/core-event-inbox-store.test.ts`
- Test: `tests/herdr-events-reader.test.ts`
- Test: focused Primary and Worker observer tests

- [x] Expose one projection frame per Core event, including its event ID,
  source/session/turn fence, source cursor, and normalized payload.
- [x] Preserve reducer context across events without grouping their settlement;
  roll it back when the event remains pending or is quarantined.
- [x] Commit projection mutation, outbound intent, and `projected` settlement in
  one transaction where the existing aggregate boundary permits it.
- [x] Settle valid non-visible events as `ignored`.
- [x] Track an error fingerprint and at most three durable attempts per event and
  reducer revision.
- [x] Quarantine only the poison event after retry exhaustion; later events in
  the same source and turn continue.
- [x] Prove Human Message, Agent Message, Tool Call, Tool Result, Goal, Task List,
  terminal lifecycle, and `record_skipped` retain their ordering semantics.
- [x] Prove a poison event cannot quarantine adjacent healthy events.

## Task 6: Add projection gaps and evidence-aware warnings

**Files:**

- Create: `src/domain/projection-gap.ts`
- Create: `src/store/sqlite/projection-gap-store.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite-integrity.ts`
- Modify: projection and card-context store capability files
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/domain/topic-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/answer-timeline-page.ts`
- Test: SQLite, reducer, card, and integration tests

- [x] Persist bounded, redacted gap identity and classification without message
  bodies, Agent output, Tool arguments, or raw provider payloads.
- [x] Open or increment one gap per stable source item and stage.
- [x] Keep a projection poison gap open until that exact event successfully
  reprojects under a later reducer revision.
- [x] Mark a delivery gap compensated only after the exact snapshot containing
  its canonical content is checkpointed as delivered.
- [x] Render exactly one aggregate warning on mutable or new pages:
  - fully catch-up eligible: `⚠ 有 N 条更新未能实时展示，当前内容已同步到最新状态。`
  - open projection omission: `⚠ 有 N 条过程更新未能展示；后续消息仍在同步。`
- [x] Keep the historical uncertain-Prompt warning separate.
- [x] Add aggregate-only status diagnostics and retention for compensated gaps.

## Task 7: Let newer mutable snapshots bypass failed updates

**Files:**

- Modify: `src/domain/delivery.ts`
- Modify: `src/domain/delivery-intent.ts`
- Modify: `src/events/outbound-intent-writer.ts`
- Modify: `src/events/outbound-delivery-executor.ts`
- Modify: `src/events/outbound-lane-drain.ts`
- Modify: `src/events/gateway-outbox-dispatcher.ts`
- Modify: `src/store/sqlite/outbox-queue-store.ts`
- Modify: `src/store/sqlite/outbox-delivery-store.ts`
- Modify: `src/store/sqlite/outbox-recovery-store.ts`
- Modify: `src/store/sqlite/outbox-recovery/failure-transition.ts`
- Modify: `src/store/sqlite/migrations/card-outbox-migrations.ts`
- Modify: Answer/Main/Worker convergence workflows as required
- Test: outbox, card-context, Answer-page recovery, and Worker-card tests

- [x] Make the lane key identify one Card/page rather than a whole binding or
  Prompt where current code is broader.
- [x] Permit a newer full mutable snapshot to dismiss a confirmed-not-applied
  older retry in the same projection transaction.
- [x] Never supersede a claimed remote-uncertain effect or a frozen-page intent.
- [x] If CardKit accepts monotonic sequence jumps, deliver the latest version;
  otherwise create a replacement card from canonical state.
- [x] A permanent or expired active Answer target creates a new CardKit page or
  card and leaves the failed target auditable.
- [x] One failed Answer page, Prompt, Main Card, or Worker Card does not block any
  independent lane.
- [x] Checkpoint the compensating snapshot and gap settlement atomically.

## Task 8: Fair scheduling, status, and operational recovery

**Files:**

- Modify: `src/events/outbound-lane-drain.ts`
- Modify: `src/events/gateway-outbox-dispatcher.ts`
- Modify: Core-event projection dispatcher introduced by Task 5
- Modify: health/status collector and schema files
- Modify: `src/runtime/sqlite-integrity-auditor.ts`
- Test: scheduling fairness, health responsiveness, status, and integrity tests

- [x] Process at most one item per lane per round with bounded total concurrency,
  item count, and wall-clock scan budgets.
- [x] Ensure retries use durable due times and cannot create a synchronous
  rescan loop.
- [x] Report isolated gaps as status degradation without making readiness fail.
- [x] Make Core/Lark global unavailability and SQLite/lease failure affect
  readiness according to the approved matrix.
- [x] Expose only aggregate counts, oldest ages, and bounded sanitized failures.
- [x] Verify shutdown settles active claims and leaves unclaimed durable work for
  startup recovery.

## Task 9: Documentation, migration, and end-to-end verification

**Repositories:** Herdr Core and Herdr Agent Swarm.

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/domain/conversation-projection/CONTEXT.md`
- Modify: `docs/domain/primary-session/CONTEXT.md`
- Modify: Core API/operator documentation
- Modify: `TODO.md` after each verified milestone

- [x] Run `git diff --check` in both repositories.
- [x] Run focused Core codec, journal, source, API, schema, and CLI tests.
- [ ] Run Core formatting, `cargo check --locked`, release build, and the full
  supported test suite. Formatting, check, schema freshness, focused tests, and
  release build pass; rerun the full suite with the required `cargo nextest`
  runner when it is available on the host.
- [x] Run focused Swarm inbox, projection, recovery, outbox, card, health, and
  integration tests.
- [x] Run Swarm `npm run typecheck`, `npm run build`, and `npm test`.
- [x] Fence startup repair of legacy detached, never-started Prompt claims by
  dispatch timestamp, native submission, transcript identity, and prepared
  model-operation evidence; preserve every evidence-bearing Prompt without
  replay.
- [ ] Verify crash recovery at every ingestion, projection, and delivery
  transaction boundary.
- [ ] Build and live-install Core first without killing existing panes.
- [x] Stage a Swarm immutable release, inspect the active-work safety gate, and
  restart only under the approved operator policy.
- [ ] Inject one controlled Feishu delivery failure, then run a real
  Herdr-origin turn and prove later Human Message, Agent Message, Tool, Goal, and
  Task List content reaches a subsequent Answer snapshot.
- [ ] Verify the failed item remains auditable, the warning count is correct,
  later FIFO work proceeds, `/health` remains responsive, and Agent execution
  count is exactly one.
