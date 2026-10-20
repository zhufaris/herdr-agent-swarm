# Core Event Recovery and Non-blocking Projection Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Recover missed Core Agent Events from the authoritative native JSONL
without replaying Prompts, keep Feishu projection failures out of the Primary
FIFO, and use audited auto-skip only when exact recovery is impossible.

**Architecture:** Herdr Core persists a compact transcript/turn index and exact
submission receipt, then reuses its bounded `SourceReader` to re-decode one
validated turn range after normal event retention. Swarm persists normalized
Core events into a fenced SQLite inbox before projection, drains projection
lanes independently from Prompt execution, rebuilds CardKit from canonical
views, and exposes a compact recovery/skip warning. Existing Core and Swarm
repositories remain independent and are released Core-first.

**Spec:** `docs/superpowers/specs/2026-09-30-core-event-recovery-and-nonblocking-projection-design.md`

## Constraints

- Never replay a Prompt that may have reached TraeX.
- Swarm never reads native JSONL directly; Core owns all transcript parsing.
- Recovery requires exact session, file identity, turn, timestamp, checkpoint,
  and anchor validation. Text digest is not recovery ownership evidence.
- Persist Core events before advancing the durable Swarm ingestion checkpoint.
- Feishu delivery, dead letters, and projection gaps do not gate Prompt FIFO.
- Preserve per-turn ordering and CardKit frozen-page immutability.
- `agent_status = blocked` is never auto-skipped.
- Worker `dispatch-uncertain` remains a separate workflow.
- Do not restore rich-text delivery or mutate runtime SQLite with ad-hoc SQL.
- Preserve unrelated dirty-worktree changes in both repositories.

## Task 1: Add a durable turn index and submission receipt to Herdr Core

**Repository:** `/tmp/herdr-core-native-goal-lifecycle`

**Files:**

- Modify: `src/agent_events/source.rs`
- Modify: `src/agent_events/journal.rs`
- Modify: `src/agent_events/codec.rs` only if stable event metadata is missing
- Test: adjacent `source.rs` and `journal.rs` unit tests

- [ ] Extend the journal migration without invalidating existing version-1 data.
- [ ] Persist a compact transcript identity and turn row with the starting
  decoder checkpoint/anchor, terminal offset/anchor, exact turn ID/start time,
  Human Message key/digest, and terminal state.
- [ ] Replace `prepared/consumed` with the explicit
  `prepared/observed/terminal/cancelled` receipt protocol while migrating old
  consumed rows to legacy-unavailable rather than fabricating turn ownership.
- [ ] Commit event insertion, duplicate-key resolution, turn indexing, and
  receipt association atomically.
- [ ] Derive logical event IDs from transcript identity plus event key so live
  and recovered copies deduplicate across terminal/source replacement.
- [ ] Keep the compact index outside ordinary event-body retention and fail
  closed when file identity or anchors change.

## Task 2: Expose typed Core recovery operations

**Repository:** `/tmp/herdr-core-native-goal-lifecycle`

**Files:**

- Modify: `src/api/schema/agent_events.rs`
- Modify: `src/api/schema/request.rs`
- Modify: `src/api/schema/response.rs`
- Modify: `src/api/server/agent_events.rs`
- Modify: `src/api/server.rs`
- Modify: `src/cli/agent_events.rs`
- Modify generated `docs/next/api/herdr-api.schema.json`
- Test: API schema, CLI parser, server, source, and journal tests

- [ ] Add `agent events capabilities` with
  `exact_turn_recovery_v1` rather than help-text feature detection.
- [ ] Add submission lookup returning only typed receipt state and proven exact
  identity.
- [ ] Add exact-turn read and session-turn enumeration operations.
- [ ] Re-decode only the indexed byte range through `SourceReader`; retain the
  same bounds, redaction, record-skipping, and normalized payload schema.
- [ ] Reject missing/replaced sources, stale anchors, malformed boundaries,
  ambiguous legacy receipts, and cross-session requests.
- [ ] Verify normal `attach/read/locate` behavior remains compatible.

## Task 3: Add the Swarm Core-event inbox and checkpoints

**Repository:** `/workspace/herdr-agent-swarm`

**Files:**

- Modify: `src/domain/ports/external.ts`
- Create: `src/domain/core-event-inbox.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Create: `src/store/sqlite/core-event-inbox-store.ts`
- Modify: store bundle/capability composition files
- Modify: `src/store/sqlite-integrity.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/sqlite-capability-graph.test.ts`

- [ ] Define normalized event envelopes, exact source/session/turn fences,
  durable cursor checkpoints, projection state, bounded failures, and stable
  deduplication keys.
- [ ] Persist a batch and its ingestion checkpoint atomically before projecting.
- [ ] Preserve inbox rows across restart until projection reaches a terminal
  outcome and retention permits cleanup.
- [ ] Add integrity checks for missing ownership, invalid cursor progression,
  duplicate logical events, and orphaned projection lanes.
- [ ] Keep payload and failure summaries bounded and redacted.

## Task 4: Extend the Swarm Core adapter and recovery coordinator

**Files:**

- Modify: `src/runtime/herdr-events-reader.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/domain/ports/external.ts`
- Create: `src/coordinator/core-event-recovery.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/transcript-observer.ts`
- Modify: `src/coordinator/detached-prompt-observer.ts`
- Modify: composition/runtime lifecycle files
- Test: `tests/herdr-events-reader.test.ts`
- Test: observer and recovery integration tests

- [ ] Probe the typed Core capability and validate every response with Zod.
- [ ] On cursor expiry, submission ownership gap, or startup reconciliation,
  request exact recovery instead of silently opening at latest.
- [ ] Recover bridge-submitted turns by submission receipt and Herdr-originated
  turns after the last durable session boundary.
- [ ] Atomically claim proven exact turns in Swarm and project idempotent live or
  recovered event copies through the same path.
- [ ] Leave transient Core failures retryable and never reinterpret them as
  unrecoverable evidence.

## Task 5: Isolate projection failures from execution and delivery

**Files:**

- Create: `src/coordinator/core-event-inbox-projector.ts`
- Modify: `src/coordinator/owned-transcript-output-projector.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: Answer/Main Card workflow and startup convergence files
- Modify: relevant projection/outbox stores
- Test: event-card, answer-page recovery, startup convergence, and outbox tests

- [ ] Drain per-turn lanes in order while allowing unrelated/later proven turn
  lanes to continue.
- [ ] Retry a failed event with exact Core recovery before quarantine.
- [ ] Quarantine failed leaf events individually; quarantine structural failure
  at the turn boundary and close the projection from a proven Core terminal
  receipt.
- [ ] Persist projection updates and outbox intent atomically.
- [ ] Ensure CardKit delivery failures never change Prompt state, ingestion
  checkpoint, or FIFO eligibility.
- [ ] Rebuild a missing/defunct Answer target from canonical SQLite state using
  an active page or new continuation card, never a frozen-page patch.

## Task 6: Add strict recovery-first auto-skip and warnings

**Files:**

- Modify: `src/config.ts`
- Modify: `src/runtime-config.ts`
- Modify: `src/store/sqlite/prompt-recovery-store.ts`
- Modify: prompt recovery coordinator/runtime composition files
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/domain/topic-view.ts`
- Modify: `src/cards/run-card.ts`
- Test: config, concurrency, recovery, run-card, and card integration tests

- [ ] Validate `DETACHED_PROMPT_AUTO_SKIP_MS` with default 30 minutes, minimum
  non-zero one minute, and zero disabled.
- [ ] Attempt exact turn and submission recovery before evaluating skip.
- [ ] Recheck FIFO head, queued successor, generation, Pane, native session,
  age, idle/done state, and observer ownership in one fenced transition.
- [ ] Atomically terminalize the unknown Prompt, update projections, reserve
  CardKit intent, append `swarm.auto_skip`, and wake the successor.
- [ ] Render one durable `⚠ 已跳过 N 条…；后续消息仍在同步` summary without
  adding it to the Human/Agent timeline or blocking new mapping.
- [ ] Render successful later recovery as a bounded `✅ 已恢复 N 条历史更新`
  summary on mutable/new pages only.

## Task 7: Coalesce unchanged Worker uncertainty diagnostics

**Files:**

- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `src/store/sqlite/worker-turn/recovery.ts`
- Test: Worker recovery/supervisor tests

- [ ] Keep Worker recovery distinct from Primary skip.
- [ ] Record one `turn.dispatch-uncertain` state transition per unchanged
  evidence fingerprint and increment aggregate observations separately.
- [ ] Permit exact Core recovery only when a Worker submission receipt proves
  ownership; otherwise remain uncertain without replay.

## Task 8: Documentation, verification, and release evidence

**Files:**

- Modify: `docs/architecture.md`
- Modify: domain context docs
- Modify: Core API/operator documentation

- [ ] Document JSONL authority, compact indexes, stable logical event IDs,
  durable inbox, projection lanes, recovery ordering, and skip boundaries.
- [ ] Run focused Core journal/source/API/CLI tests and schema generation checks.
- [ ] Run Core formatting, clippy, nextest/full repository gates supported by
  this host.
- [ ] Run focused Swarm recovery, SQLite, projection, outbox, and card tests.
- [ ] Run Swarm `npm run typecheck`, `npm run build`, `npm test`, and
  `git diff --check`.
- [ ] Run the spec acceptance integration: pruned live events, exact JSONL
  recovery, durable inbox restart, Feishu delivery failure, later FIFO progress,
  CardKit rebuild, and one truly unrecoverable audited skip.
- [ ] Do not install or restart until immutable builds are ready and the active
  work safety gate has been explicitly evaluated.
