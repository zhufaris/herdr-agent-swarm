# Primary Main Card Recent Conversation Implementation Plan

**Goal:** Show the latest five user/Agent messages on the Primary Main Card.

**Design:** Maintain a bounded, durable `recentConversation` projection in the
Topic View, derive it from Primary run cards, backfill it during startup, and
render it with the existing Main Card payload budget.

## Task 1: Add the pure bounded conversation projection

**Files:**

- Modify `src/domain/topic-view.ts`
- Modify `tests/topic-view.test.ts`

1. Define the recent-message role and entry types.
2. Hydrate legacy Topic Views with an empty array.
3. Add a pure projection helper that upserts request and non-empty Agent reply
   entries by prompt/role key, orders them deterministically, and retains five.
4. Make `mirrorRunCardToTopic` update the conversation projection.
5. Include the array in Topic View presentation equality.

## Task 2: Keep live projection and startup backfill current

**Files:**

- Modify `src/events/conversation-view-projector.ts`
- Modify `src/domain/ports/workflow.ts`
- Modify `src/store/sqlite/projection-store.ts`
- Modify `src/store/sqlite/recovery-capability-store.ts`
- Modify `src/coordinator/startup-view-converger.ts`
- Modify `tests/event-card-integration.test.ts`
- Modify `tests/startup-view-converger.test.ts`
- Modify relevant store/fake implementations

1. Mirror the event-updated Run Card into the Topic View before scheduling the
   Main Card.
2. Add a bounded store query for the latest run cards of a binding.
3. During startup, derive recent conversation from those cards before Main Card
   convergence.
4. Verify repeated live events and repeated startup convergence are idempotent.

## Task 3: Render five role-labelled messages

**Files:**

- Modify `src/cards/run-card.ts`
- Modify `tests/run-card.test.ts`

1. Replace `💬 最新消息` with `💬 最近对话` when history is present.
2. Render entries oldest to newest with `用户` and Agent labels.
3. Share the existing 3,000-character budget while preserving message
   boundaries and newest content.
4. Retain the legacy latest-answer fallback for empty history.

## Task 4: Verify and prepare deployment

1. Run focused Topic View, event projection, startup convergence, store, and
   Main Card tests.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Commit only the implementation and its tests.
4. Install from the isolated clone and restart only when the existing active
   work safety gate reports zero active work; never use `--force`.
