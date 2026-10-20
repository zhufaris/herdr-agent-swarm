# Answer Input Queue and cgkx Choice Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: [Answer Input Queue and cgkx Choice Recovery](../specs/2026-10-14-answer-input-queue-and-cgkx-choice.md).

Gate 1 design A approved. Workspace is isolated at
`/tmp/herdr-agent-swarm-answer-input-queue`, branch `fix/answer-input-queue`,
base `ffdb846985a775060c85bc3b17254cc95867b089`. The original main worktree
contains five unrelated staged user files and is not mutated by this plan.

Baseline: `npm ci`, typecheck, architecture check, TurnCardWorkflow tests and
Human Turn Card integration tests passed. Clean main reproduces one unrelated
prepared-delivery claim failure in `tests/conversation-segment-store.test.ts`;
the failure is preserved as a baseline risk, not attributed to these tickets.

## Wave W1: `T1`

### - [x] T1: Preserve working Answer cards while queueing later Human Messages

| Field | Content |
| --- | --- |
| What to build | Keep a working prior Conversation Segment and active Answer page alive when a later Human Message arrives; create the new Segment independently, route later Core events by exact turn identity, and let Pane-scope delivery order the two card intents. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded SQLite/domain/coordinator behavior with temporary database and integration test seams; no credentials or production mutation; main owns independent verification and commit. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteConversationSegmentStore.projectCanonicalEventInTransaction` preserves `working` prior Segments on new Human Message projection and adds exact `turn_id` lookup for non-terminal events. Existing outbox/Panescope delivery and TurnCardWorkflow remain the presentation path. |
| Mutation ownership | src/store/sqlite/conversation-segment-store.ts, tests/conversation-segment-store.test.ts, tests/human-turn-card.integration.test.ts, tests/turn-card-workflow.test.ts, docs/spec-coder/specs/2026-10-14-answer-input-queue-and-cgkx-choice.md, docs/spec-coder/plans/2026-10-14-answer-input-queue-and-cgkx-choice.md |
| Exclusions | No input admission gate, schema migration, CardKit bypass, Worker behavior change, historical data repair, or cgkx pane restart. Preserve main's existing staged files. |
| Isolation | Serial mutation in this isolated worktree at base `ffdb846985a775060c85bc3b17254cc95867b089`; no parallel mutation. |
| Concurrency conflicts | None |
| Verification seam | Canonical projection with interleaved A/B Human and assistant/tool/final events; inspect Segment state, item ownership, page state, outbox intents and duplicate/reopen behavior. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | delegation_allowed = false; worker must not spawn, stage, commit, deploy, restart, or edit outside ownership. Main owns Red/G​reen acceptance, integration, checkbox, staging and commit. |
| Acceptance criteria and verification | A working Answer Segment remains working and its card is not grayed or finalized when B arrives; B creates an independent Segment/page; A's later exact-turn events remain in A; B is durably queued; terminal/supersession behavior remains for non-working prior states. Run focused tests, typecheck, architecture check, build, diff check and full suite; record the known baseline failure separately. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/human-turn-card.integration.test.ts tests/turn-card-workflow.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --check` |
| Verification results | Main observed the intended Red, then T1 Green; focused owned suites 141/142 passed with one known unrelated clean-main prepared-delivery claim failure; Human Turn Card and TurnCardWorkflow suites passed; typecheck, architecture check, build, and diff check passed. |
| Commits | `e095395e` |

## Wave W2: `T2`

### - [ ] T2: Recover cgkx choice-list rendering after stale session replacement

| Field | Content |
| --- | --- |
| What to build | Restart or replace only the explicitly named `cgkx` TraeX session, then verify a new final produces canonical `completion_choice`, a trusted Action Set, a completion-review outbox card with buttons, and the expected mention. |
| Spec references | SCN-5, INV-5 |
| Dependencies | T1 |
| Delegation eligibility | Not code-delegable: requires live Herdr pane/session operation and real Feishu/SQLite evidence. Main-only operational action. |
| Delegation mode | main-local; explicit live-pane operation required |
| Mutation ownership | None |
| Exclusions | No guessed pane, no broad workspace restart, no historical SQLite repair, no code mutation, no production database edits. |
| Isolation | Main-local operational follow-up after T1; use exact pane token `cgkx` and verify before/after session identity. |
| Concurrency conflicts | None |
| Verification seam | Live Herdr session start vs hook mtime, bridge.db Core final event, completion choice specification, Action Set, and delivered completion-review payload. |
| Host capacity | Requires current Herdr access and one named pane; no worker dispatch. |
| Direct-child boundary | delegation_allowed = false; main owns the live operation and final evidence. |
| Acceptance criteria and verification | A post-restart cgkx final contains valid `completion_choice`; SQLite has the matching specification and Action Set; outbound payload contains a rendered review card with buttons and trusted mention. |
| Blocked by | T1 |

## Final delivery checks

Main reviews the T1 diff, commits it atomically, runs fresh affected/full checks,
then performs T2 only with the explicit pane evidence above. No push or PR is
implied.

## Wave W3: `T3`

### - [x] T3: Project current collaboration Subagent activity into cards

| Field | Content |
| --- | --- |
| What to build | Accept the current `collaboration__spawn_agent`, `collaboration__wait_agent`, and `collaboration__interrupt_agent` tool protocol alongside the retired `multi_agent_v1__*` aliases, then project bounded Subagent lifecycle facts through the existing Session Activity and card renderers. |
| Spec references | SCN-6, INV-6, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded runtime translator, SQLite projection, and focused test seam; no credentials or production mutation. Main-local execution was selected for this resumed worktree to preserve the user's existing staged files. |
| Delegation mode | main-local |
| Concurrency conflicts | None |
| Mutation ownership | `src/runtime/multi-agent-tool-lifecycle.ts`, `src/store/sqlite/session-activity-store.ts`, `tests/session-activity-store.test.ts`, `docs/spec-coder/specs/2026-10-14-answer-input-queue-and-cgkx-choice.md`, `docs/spec-coder/plans/2026-10-14-answer-input-queue-and-cgkx-choice.md` |
| Exclusions | No new card family, table/data migration, private Subagent transcript/result content, Worker dispatch changes, or live-pane restart. A bounded index migration is included only to keep retained-activity recovery indexed for both tool-name families. Preserve main's existing staged files. |
| Verification seam | Correlated current collaboration spawn/wait/interrupt Core events produce one bounded Subagent item and preserve the existing legacy protocol tests; malformed and cross-session evidence remains rejected. |
| Acceptance criteria and verification | The Red test fails before the patch; the minimal translator/query alias patch passes the focused session-activity suite, existing protocol/projector suites, typecheck, architecture check, build and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/session-activity-store.test.ts tests/herdr-event-projector.test.ts tests/herdr-events-protocol.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --check` |
| Verification results | Red reproduced before the patch; current collaboration spawn/wait/interrupt, legacy protocol, session-activity, projector, migration, typecheck, architecture check, build and diff checks passed. The full repository suite still has unrelated failures from the five pre-existing staged user files; no T3-owned test failed. |
| Commits | Pending T3 atomic commit |
