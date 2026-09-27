# Core Agent Events and Main Card Recent Messages Implementation Plan

**Goal:** Make Herdr Core Agent Events the sole structured reply source for
Primary and Worker turns, retain `update_plan` task lists, and render the latest
five Agent messages on the Primary Main Card.

**Design authority:**
`docs/superpowers/specs/2026-09-27-core-agent-events-main-card-messages-design.md`.

## Working-copy and commit boundaries

The shared `herdr-core` and `herdr-agent-swarm` checkouts contain unrelated
uncommitted work. Do not edit, clean, reset, or commit either shared checkout.

1. Create an isolated `/tmp` checkout for Herdr Core from `a811e397` and port
   only the existing Agent Events draft from the shared checkout.
2. Continue Swarm work in the isolated checkout containing this plan and the
   previously integrated Card/Answer commits.
3. Keep Core resilience, Swarm event-only observation, and Main Card projection
   in separate commits so each boundary can be reviewed and reverted
   independently.
4. Do not push either repository.
5. Before committing in Herdr Core, show the proposed lowercase conventional
   commit message for approval as required by that repository.

## Task 1: Characterize and harden Herdr Core record handling

**Repository:** `herdr-core`

**Files:**

- Modify `src/agent_events/codec.rs`
- Modify `src/agent_events/source.rs`
- Modify `src/agent_events/mod.rs` if recoverable decoder errors need an
  explicit classification
- Modify `src/api/server/agent_events.rs` only if source recovery or attachment
  behavior needs adjustment

1. Add failing codec tests for an unknown TraeX top-level record, an unknown
   response item, and an unknown history mutation operation.
2. Assert that each safe unknown record produces one bounded
   `ReplyPayload::RecordSkipped` with a stable code and does not mutate the
   current turn, last-message identity, or tool state.
3. Preserve hard failures for malformed JSON, invalid required fields, turn
   identity mismatches, session identity mismatches, file replacement, and
   branch-parent violations.
4. Implement an explicit recoverable-decoder-error classification instead of
   converting every decode failure into a skipped record.
5. Add source-reader tests proving a recoverable record advances the checkpoint
   and a later valid message is emitted from the same source.
6. Add a test for attaching at the end while the trailing record exceeds
   `MAX_RECORD` and is not newline-terminated.
7. Change end-checkpoint logic so it can discard or resume past that partial
   record with bounded memory, then consume the next complete record. Do not
   retain the oversized body in state, events, or logs.
8. Retain the existing mid-stream `OversizedComplete` behavior and add a test
   proving the next record remains readable.
9. Run focused tests:

   ```bash
   just test-one agent_events
   ```

## Task 2: Verify the Herdr Core journal and API contract

**Repository:** `herdr-core`

**Files:**

- Modify `src/agent_events/journal.rs` only if a new checkpoint field is needed
- Modify `src/api/schema/agent_events.rs` only if serialized checkpoint state
  requires a backward-compatible default
- Modify `tests/api_ping.rs`
- Modify `docs/next/website/src/content/docs/` only when an existing Agent
  Events operator/API page is present

1. Add an API-level fixture containing an unsupported record, an oversized
   record, a message, a tool call/result, and terminal lifecycle.
2. Assert `agent.events.read` advances monotonically and returns the valid
   events after skipped records without duplicate event IDs.
3. Assert `agent.events.subscribe` resumes after the supplied cursor and does
   not replay already delivered events.
4. Assert a genuine runtime/session identity change still marks the old source
   failed.
5. Keep all existing request and response shapes unchanged; this hardening does
   not require a new stable endpoint generation.
6. Run `just check`. Because this touches persisted state, API behavior, and
   runtime identity, run the repository-required broad-refactor roundtable and
   resolve its actionable findings before commit.
7. Propose `fix: keep agent event sources readable after unknown records` as the
   Core commit message, obtain approval, then commit without an AI co-author
   trailer.

## Task 3: Build and stage Herdr Core safely

**Repository:** `herdr-core`

1. Run `just bench-release-smoke` because the source collector is a recurring
   multi-source runtime path.
2. Build the release binary with `just build`.
3. Inspect the running Herdr version, endpoint capabilities, sessions, and
   Agent Event source health before installation.
4. Install using the supported local release workflow and use live handoff for
   compatible running servers. Do not stop or recreate Pane processes.
5. Verify the new server identity and existing Pane/session continuity.
6. Attach controlled fixtures or existing identity-fenced sources and verify
   that unknown and oversized records no longer strand the source.
7. Do not expose transcript bodies, tool arguments, or secrets while reporting
   source status.

## Task 4: Make Swarm composition event-only

**Repository:** `herdr-agent-swarm`

**Files:**

- Modify `src/config.ts`
- Modify `src/setup/setup-config.ts`
- Modify `src/composition/create-infrastructure-runtime.ts`
- Modify `src/runtime/herdr-events-reader.ts`
- Modify `src/runtime/agent-transcript-reader.ts`
- Modify `src/runtime/traex-transcript.ts`
- Modify `src/runtime/pi-transcript.ts`
- Modify `.env.example`
- Modify `tests/config.test.ts`
- Modify `tests/service-lifecycle.test.ts`
- Modify `tests/herdr-events-reader.test.ts`
- Remove `src/runtime/herdr-events-shadow.ts`
- Remove `tests/herdr-events-shadow.test.ts`

1. Port and review the existing uncommitted Agent Events draft without
   importing unrelated shared-worktree changes.
2. Add failing configuration tests proving `HERDR_REPLY_OBSERVATION` is no
   longer accepted or emitted by setup.
3. Make `HerdrEventsReader` the only production `AgentTranscriptReaderPort`
   assembly for supported Agent kinds.
4. Retain only bounded descriptor discovery needed by Core attach. Remove
   direct transcript content parsing from the production graph.
5. Remove JSONL/shadow configuration, selection, telemetry, and tests.
6. Keep exact Pane, terminal, Agent kind, native session, turn ID, and start-time
   fences on initial observation and detached recovery.
7. Add reader tests for source errors, cursor stall, cursor replay, repeated
   message IDs, final messages, tool pairs, skipped records, and exact-turn
   recovery.
8. Run:

   ```bash
   npx vitest run tests/config.test.ts tests/service-lifecycle.test.ts tests/herdr-events-reader.test.ts tests/transcript-observer-identity.test.ts
   npm run typecheck
   ```

## Task 5: Preserve task lists from Core tool events

**Repository:** `herdr-agent-swarm`

**Files:**

- Add `src/runtime/plan-snapshot.ts`
- Modify `src/runtime/traex-transcript-projector.ts` while removing its runtime
  role
- Modify `src/runtime/herdr-events-reader.ts`
- Add `tests/plan-snapshot.test.ts`
- Modify `tests/herdr-events-reader.test.ts`
- Modify `tests/topic-view.test.ts`
- Modify `tests/worker-turn-observer.test.ts`

1. Move the existing bounded `update_plan` and wrapped
   `tools.update_plan(...)` parsing into a pure shared function.
2. Add failing tests for direct calls, exec-wrapped calls, quoted property
   names, invalid JSON, truncated arguments, more than 100 steps, and empty
   labels.
3. In `HerdrEventsReader`, recognize valid plan tool calls before projecting
   generic tool activity and populate `AgentTranscriptMainStatus.planSteps`.
4. Do not emit `update_plan` itself as an Answer tool panel or Main Card current
   activity.
5. Preserve the last valid plan when a later plan call is invalid or truncated.
6. Verify Primary and Worker observers receive the same plan snapshot contract.
7. Run:

   ```bash
   npx vitest run tests/plan-snapshot.test.ts tests/herdr-events-reader.test.ts tests/topic-view.test.ts tests/worker-turn-observer.test.ts
   npm run typecheck
   ```

## Task 6: Add durable recent Agent messages

**Repository:** `herdr-agent-swarm`

**Files:**

- Modify `src/domain/ports/external.ts`
- Modify `src/domain/events.ts`
- Modify `src/domain/topic-view.ts`
- Modify `src/domain/run-card-view.ts` only if timeline-to-topic mirroring needs
  a named helper
- Modify `src/coordinator/owned-transcript-output-projector.ts`
- Modify `src/store/sqlite/projection-store.ts`
- Modify `tests/topic-view.test.ts`
- Modify `tests/sqlite-store.test.ts`
- Modify `tests/owned-transcript-output-projector.test.ts`

1. Add the `MainCardAgentMessage` domain type and carry message deltas from
   `AgentTranscriptObservation` without parsing rendered Answer Markdown.
2. Add reducer tests proving a new turn clears old messages, the latest ten are
   retained, repeated IDs update in place, cursor order is stable, and an
   identical adjacent final replaces commentary rather than duplicating it.
3. Apply message updates in the same durable Topic View transition as Answer,
   task-list, and activity updates.
4. Normalize older `topic_views.state_json` rows with
   `recentAgentMessages: []`; do not add a separate SQL column.
5. Ensure `sameTopicPresentation` includes recent messages so a visible change
   increments `viewVersion` exactly once.
6. Verify replaying the same event range is idempotent.
7. Run:

   ```bash
   npx vitest run tests/topic-view.test.ts tests/sqlite-store.test.ts tests/owned-transcript-output-projector.test.ts
   npm run typecheck
   ```

## Task 7: Render the revised Primary Main Card

**Repository:** `herdr-agent-swarm`

**Files:**

- Modify `src/cards/run-card.ts`
- Add or modify a focused message-preview helper under `src/cards/`
- Modify `tests/run-card.test.ts`
- Modify `tests/card-style.test.ts` only if a shared heading helper changes

1. Replace the six-line accumulated-answer preview with the last five
   `recentAgentMessages`.
2. Render every message as an independent Markdown element with a compact Agent
   or completion marker, preserving fenced-code integrity.
3. Apply an item bound and a total section bound using existing Markdown-safe
   truncation helpers; keep both useful ends around an explicit omission marker.
4. Omit the section when no Agent message exists.
5. Change current activity selection to the latest active non-plan tool only.
6. Render sections in the approved order: current task/task list, recent
   messages, current activity, Workers, runtime footer.
7. Retain actionable error/review callouts, current Answer navigation, Worker
   controls, pane identity, model/context, queue metrics, and CardKit payload
   bounds.
8. Add card tests for zero through six messages, duplicate final content, long
   Markdown, code fences, active-versus-completed tools, actionable states, and
   exact section order.
9. Run:

   ```bash
   npx vitest run tests/run-card.test.ts tests/card-style.test.ts tests/topic-view.test.ts
   npm run typecheck
   ```

## Task 8: Verify Primary and Worker recovery end to end

**Repository:** `herdr-agent-swarm`

**Files:**

- Modify `tests/concurrency-controls.integration.test.ts`
- Modify `tests/pane-thread-lifecycle-integration.test.ts`
- Modify `tests/instance-messaging.integration.test.ts`
- Modify `tests/event-card-integration.test.ts`
- Modify `tests/answer-page-workflow.test.ts` when timeline replay coverage is
  not already sufficient

1. Add a Primary turn fixture containing plan, commentary, tool activity,
   final answer, and completion from Core events.
2. Add the equivalent Worker turn fixture and assert its Task Card tool panels
   and result are intact.
3. Replay the same cursor range and assert no duplicate Answer timeline rows,
   Main Card messages, tool panels, or outbox intent.
4. Simulate Core unavailability and assert the observer detaches or becomes
   uncertain without reading JSONL, clearing durable output, or replaying the
   prompt.
5. Simulate restart recovery for an exact persisted turn and assert observation
   resumes from Core history.
6. Run all affected integration tests, then:

   ```bash
   npm run typecheck
   npm run architecture:check
   npm run docs:audit
   npm test
   npm run build
   ```

## Task 9: Update current documentation and commit Swarm changes

**Repository:** `herdr-agent-swarm`

**Files:**

- Modify `README.md`
- Modify `docs/architecture.md`
- Modify `docs/feishu-group-usage.md` if it describes Main Card content
- Modify `docs/superpowers/README.md`

1. Describe Herdr Core Agent Events as the only reply source and snapshot as the
   separate runtime-identity authority.
2. Remove JSONL/shadow operator configuration and fallback language.
3. Document the five-message Main Card behavior, task-list source, section
   order, and fail-closed recovery.
4. Record the Core version or capability prerequisite without claiming support
   before the matching Core build is installed.
5. Run the complete Swarm verification suite again after documentation changes.
6. Commit in reviewable units:
   - `refactor: use core agent events for all replies`
   - `feat: show recent agent messages on main cards`
   - `docs: document core event reply authority`
7. Verify every commit body and remove any automated AI co-author trailer before
   any future push. Do not push.

## Task 10: Install and verify production

1. Confirm the installed Herdr Core build contains the hardened Agent Events
   behavior and that existing Pane/session identities survived handoff.
2. Run `./install.sh` from the verified Swarm checkout to stage an immutable
   release.
3. Run `npm run swarm:status` and inspect all active-work safety fields.
4. If the safety gate is clear, run `npm run swarm:restart` without `--force`.
   If it is not clear, do not force unless the user explicitly authorizes that
   specific restart.
5. Run `npm run swarm:status` again and verify expected/observed commit and build
   identities, ownership, and `readiness.status=ready`.
6. Without printing message bodies or secrets, verify durable SQLite evidence
   for one completed Primary turn and one completed Worker turn:
   - Core event cursor advanced;
   - Answer timeline contains Agent and Tool items;
   - task list was projected from `update_plan`;
   - Main Card contains at most five distinct Agent messages;
   - no duplicate timeline rows or delivery intents were created.
7. Inspect bounded service logs for Core source errors and Swarm observation or
   delivery failures. Report exact blockers instead of bypassing them.
