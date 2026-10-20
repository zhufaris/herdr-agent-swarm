# Turn Card Presentation Polish Implementation Plan

Specification: [2026-10-05-turn-card-presentation-polish.md](../specs/2026-10-05-turn-card-presentation-polish.md)

Workspace: `/workspace/herdr-agent-swarm` (safe in-place execution)

Branch and starting revision: `main` at `95275f7afebc0731f718504a4e344cc30ca82bec`

Baseline: `npm test` passed 272 files / 3,884 tests; `npm run typecheck`, `npm run build`, and `git diff --check` passed. Existing user-owned `TODO.md` and the three pre-existing untracked documents listed in the specification remain outside ticket ownership.

Approval status: Gate 1/2/3 were reopened after Task List durability and reserved system-envelope filtering expanded scope. The user's explicit instruction to finish all known work through deployment without repeated confirmation authorizes the revised design, specification, ticket set, and implementation.

## Tickets

### - [x] T1: Unify request hierarchy and collapsed timeline panels

**What to build**

Deliver the visible Turn Card structure in which page zero and continuation pages use the same bounded `reply to 💬: <message>` header title, omit duplicated request body content, and every Thinking, Tool, Tool Group, and Status disclosure starts collapsed. Preserve request sanitization, state colors, notification summary, and running animation frames.

**Spec references**

- SCN-1: Consistent reply title
- SCN-2: Predictable disclosure panels
- INV-1: Canonical authority
- Architecture: existing Turn Card and Answer timeline renderer interfaces remain unchanged

**Ownership and implementation path**

Card Presentation owns this behavior. Change only the pure shell and timeline renderers in `src/cards/turn-card.ts` and `src/cards/answer-timeline.ts`, plus their focused tests. No domain, persistence, coordinator, SDK, outbox, or delivery-lane dependency may be introduced. Existing request redaction/normalization and panel header models remain authoritative.

**Acceptance criteria and verification**

- Page zero and continuation cards both contain the same `reply to 💬: <message>` title bounded to 80 UTF-16 code units.
- Request text is redacted, ANSI-free and single-line in the title, and absent from the body; continuation page identity remains in the subtitle.
- Running, succeeded, and failed Tool panels; Tool Groups; Thinking; and Status panels all render `expanded: false`.
- Tool titles, colors, state labels, and animation frames retain their existing observable output.
- Red first through `tests/turn-card.test.ts` and `tests/answer-timeline-card.test.ts`; Green through those focused files.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` before the atomic ticket commit.

**Blocked by**

None.

### - [x] T2: Preserve a stable bounded Thinking display across pagination

**What to build**

Deliver a render-only Thinking detail policy that shows normalized/redacted content completely through 6,000 source characters, otherwise retains the first and last 3,000 source characters around an explicit omission-count marker. Make the page planner place that stable display copy as one indivisible item, carrying the same cursor to a continuation page when prior content leaves insufficient room.

**Spec references**

- SCN-3: Complete ordinary Thinking
- SCN-4: Explicitly bounded long Thinking
- SCN-5: Canonical ordering survives pagination
- INV-1: Canonical authority
- INV-2: Stable Thinking copy
- INV-3: Cursor ownership
- INV-4: Safe content
- Behavior & Failure Modes: deterministic compaction, continuation placement, and no infinite same-cursor loop

**Ownership and implementation path**

Card Presentation owns both the stable display-copy policy and item placement. Keep compaction private to `src/cards/answer-timeline.ts`; update `src/cards/answer-timeline-page.ts` only to distinguish a stable Thinking panel from residual-budget rendering. Reuse existing redaction, ANSI removal, and Lark Markdown normalization helpers. Preserve `AnswerTimelineItem`, `AnswerTimelineCursor`, and exported renderer/planner interfaces unchanged.

**Acceptance criteria and verification**

- A normalized Thinking body of at most 6,000 characters is rendered completely.
- Longer Thinking retains the expected first and last 3,000 normalized source characters and reports exact omitted line/character counts.
- Secret redaction and ANSI/Markdown normalization occur before head/tail selection.
- A Thinking item that cannot fit after earlier page elements is not shortened or consumed; the next cursor still points to that item.
- The next page renders the same stable display copy once, then advances to later canonical items without skip, duplicate, or re-sort.
- Pathological low payload limits converge through existing explicit overflow behavior and cannot loop indefinitely.
- Red first through `tests/answer-timeline-card.test.ts` and `tests/answer-timeline-page.test.ts`; Green through all three affected card test files.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` before the atomic ticket commit.

**Blocked by**

None. T1 is the preferred execution order because both tickets touch the timeline renderer, but it does not supply a functional prerequisite.

### - [x] T3: Persist and render canonical Task Lists

**What to build**

Carry normalized `update_plan` steps from the canonical Core projector into the current Conversation Segment, persist the latest list transactionally, and load it into the existing Turn Card Task List section across replay and restart.

**Spec references**

- SCN-6: Durable Task List projection
- INV-5: Durable plan view
- INV-7: Core order authority
- Architecture: projector normalization, capability boundary data, and SQLite segment-owned view state

**Ownership and implementation path**

Core event decoding remains in `CanonicalEventProjector`; `SqliteCapabilityGraph` forwards normalized plan steps; `SqliteConversationSegmentStore` owns transactional persistence and `ConversationSegmentCardView` mapping. Add one idempotent migration column to `conversation_segments`. Do not reconstruct plan state from Lark, terminal text, or timeline tool labels.

**Acceptance criteria and verification**

- A canonical `update_plan` call updates the open segment's ordered Task List and increments its view version.
- The renderer receives the same Task List after reopening the SQLite database.
- Identical replay is idempotent; changed/empty plans update exactly once and render the corresponding current list/no-list state.
- The update and any timeline delta from that canonical event commit atomically under the existing transaction.
- Red first through `tests/conversation-segment-store.test.ts` using the capability graph seam; Green through focused store/card tests.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` before the atomic ticket commit.

**Blocked by**

None.

### - [x] T4: Suppress reserved system Human envelopes

**What to build**

Prevent complete reserved `<goal_context>`, `<scheduled-task ...>`, and generated AGENTS.md instruction canonical Human envelopes from creating visible Conversation Segments, Human Requests, card pages, or outbox effects, without relying on submission identity or changing Core order.

**Spec references**

- SCN-7: Reserved system envelopes stay invisible
- INV-6: Reserved-envelope precision
- INV-7: Core order authority
- Behavior & Failure Modes: ignored visible boundary preserves the current real segment

**Ownership and implementation path**

Use a pure exact-envelope classifier at the Conversation Segment projection boundary before closing/opening visible segments. Keep durable Core ingestion and checkpoint behavior unchanged. Legitimate direct-Herdr Human Messages remain visible regardless of missing `submission_id`.

**Acceptance criteria and verification**

- Complete trimmed `goal_context`, attributed `scheduled-task`, and generated AGENTS.md instruction envelopes produce `ignored` with no segment/page/outbox creation.
- If a real segment is open, the envelope does not close it and the following canonical timeline delta remains attached in original Core order.
- Plain text, malformed/partial tags, text that merely mentions either tag, and ordinary requests to read AGENTS.md remain visible direct-Herdr Human turns.
- The implementation never checks null `submission_id` as a system signal and never mutates/reorders Core inbox events.
- Red first and Green through `tests/conversation-segment-store.test.ts`, then run the affected core-inbox/store integration tests.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` before the atomic ticket commit.

**Blocked by**

None.

## Final Delivery Checks

- Review the complete ticket commit range against the approved specification and repository instructions.
- Confirm only task-owned product, test, specification, and plan paths are staged or committed; preserve all initial user-owned changes.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` freshly.
- Verify architecture-boundary tests remain green and no JSONL, SQLite, domain timeline, outbox, or delivery contract changed.
- Inspect the final commits and ensure no `Trae CLI co-author attribution` trailer exists.
- Merge ticket commits into local `main` if implementation used another branch; do not push.
- After verified delivery, run `./install.sh`, then `npm run swarm:restart -- --force` as explicitly authorized by the user, and verify active build identity, startup recovery, Core ingestion, outbox dispatcher, and readiness diagnostics.
