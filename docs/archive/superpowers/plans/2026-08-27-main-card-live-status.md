# Main Card Live Status Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused tests before production changes.

**Goal:** Capture the current TraeX status heading and structured plan from the authoritative JSONL stream and render them as a durable Main Card status area without mixing them into Answer Card content.

**Architecture:** Read each JSONL record once and return a structured transcript delta with two independent consumer payloads. Answer Card consumes only answer Markdown and tool activity; Main Card consumes only a bounded status title, the latest complete plan snapshot, elapsed time derived from the durable turn start, and token usage only when a reliable per-turn value can be derived. Both projections retain their own versioning, persistence, rendering, and delivery behavior.

**Tech Stack:** TypeScript, Zod, Vitest, SQLite, Lark CardKit

**Spec:** Approved conversation design from 2026-08-27.

## Global Constraints

- Never expose reasoning prose; retain only the first bounded bold heading from an allowed TraeX reasoning status event.
- Never derive status from user, developer, approval-review, tool-output, or embedded transcript text.
- Map `update_plan` states as `pending -> pending`, `in_progress -> active`, and `completed -> done`.
- Main Card and Answer Card independently consume different fields from one parsed JSONL observation.
- Once an Answer Card page is frozen and will no longer receive stream updates, render its header green.
- Preserve prompt replay safety, SQLite durability, outbox idempotency, Answer pagination, and terminal fallback behavior.
- Preserve existing uncommitted terminal-fallback-warning work.

---

### Task 1: Structured transcript observation

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Produces: `TraexTranscriptDelta` with `answerDelta` and optional `mainStatus`.
- Produces: a bounded `statusTitle`, complete `planSteps`, and optional reliable `tokenCount`.

- [ ] Add failing tests proving a valid reasoning event yields only its leading heading.
- [ ] Add failing tests proving user/developer/tool content and reasoning body never become a status title.
- [ ] Add failing tests proving `update_plan` arguments become a complete ordered plan snapshot.
- [ ] Add failing tests for token counters and malformed or oversized input.
- [ ] Implement the structured cursor result while preserving answer rendering and item idempotency.
- [ ] Run `npx vitest run tests/traex-transcript.test.ts`.

### Task 2: Independent card projection contracts

**Files:**
- Modify: `src/domain/events.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/domain/run-card-view.ts` only if Answer-specific compatibility requires it
- Modify: `src/domain/topic-view.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/topic-view.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptDelta`.
- Produces: `TurnOutputObserved.mainStatus`, consumed only by `TopicViewState`.
- Preserves: `TurnOutputObserved.answerSnapshot` and `progressEvents`, consumed only by `RunCardView`.

- [ ] Add failing workflow tests proving one observation routes answer fields and Main Card fields independently.
- [ ] Add reducer tests proving duplicate status snapshots do not advance Main Card version or activity time.
- [ ] Add reducer tests proving a new turn clears old live status and a terminal turn removes transient runtime state.
- [ ] Implement event wiring and independent reducers.
- [ ] Run focused workflow and reducer tests.

### Task 3: Durable Main Card status presentation

**Files:**
- Modify: `src/domain/topic-view.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/progress-timeline.ts` if a dedicated full-plan renderer is needed
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: durable `TopicViewState.liveStatus`.
- Produces: a Main Card status panel containing the latest title, elapsed time, optional token count, current step, and collapsible complete plan.

- [ ] Add migration-normalization tests for stored views without `liveStatus`.
- [ ] Add CardKit tests for bounded headings, exact plan-state icons, complete-plan expansion, and absent unreliable metadata.
- [ ] Implement rendering without placing the status panel in Answer Cards.
- [ ] Run focused persistence and card tests.

### Task 4: Verification and deployment

**Files:**
- Modify: `docs/architecture.md`

- [ ] Document the one-source/two-consumer projection boundary.
- [ ] Run all affected Vitest files.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Inspect `git diff --check` and the final scoped diff.
- [ ] Restart through `herdr plugin action invoke restart --plugin herdr-lark-bridge`.
- [ ] Verify plugin status, readiness, build identity, and pending outbox count.
