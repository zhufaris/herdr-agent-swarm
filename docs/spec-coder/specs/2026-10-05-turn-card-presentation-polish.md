# Turn Card Presentation Polish Specification

## Problem Statement

Canonical Human Turn Cards repeat request context in a standalone body section even though the bounded request is the conversational identity readers need first. The request should identify the reply directly in the CardKit header without consuming body space or using a second presentation model on continuation pages.

Collapsible timeline panels also have inconsistent initial state. Thinking and successful Tool panels start collapsed, while running or failed Tool panels and Tool groups can start expanded. Users want every disclosure panel to begin collapsed while keeping enough status in the header to understand current activity without opening it.

Thinking items already carry a summary label and a Markdown detail body, but the renderer sizes that body from the current page's remaining payload budget. A short Thinking item can therefore be silently shortened merely because earlier items consumed space, and an oversized item preserves only its head. The intended behavior is a stable render-only copy: complete for ordinary Thinking, or an explicit head/tail preview for unusually long Thinking, with pagination moving the whole preview instead of changing its content.

Canonical Core projection already decodes `update_plan` calls into `mainStatus.planSteps`, but the Conversation Segment integration drops that value and `loadCardView()` never supplies `taskList`. As a result the Turn Card renderer's existing Task List section has no durable input and cannot survive restart/replay.

Core can also emit reserved system envelopes as `human_message` records. In particular, complete `<goal_context>...</goal_context>`, `<scheduled-task ...>...</scheduled-task>`, and generated AGENTS.md instruction blocks currently create visible Human Request segments even though they were injected by the host rather than entered by the user. Production evidence shows the AGENTS block has an exact generated structure: `# AGENTS.md instructions for <path>`, a complete `<INSTRUCTIONS>` block, and an optional complete `<environment_context>` block. Null `submission_id` cannot classify these records because legitimate direct-Herdr Human Messages also omit that identity.

## Solution

Keep Core JSONL and the durable Answer timeline authoritative and unchanged. Apply all requested behavior inside the pure CardKit presentation path:

- render a single bounded header title `reply to 💬: <message>` on page zero and continuation pages, with no duplicated Human Request body section;
- initialize every collapsible Thinking, Tool, Tool Group, and Status panel with `expanded: false`, while retaining lifecycle icons, labels, animation, and border colors in panel headers;
- normalize, redact, and sanitize Thinking Markdown before producing a stable display copy;
- display normalized Thinking in full through 6,000 characters; for longer content, retain the first 3,000 and last 3,000 source characters and insert an explicit marker reporting omitted lines and characters;
- treat that stable Thinking display copy as indivisible for page placement: when it cannot fit after existing page content, keep the cursor on the same canonical item and place it on the next continuation page instead of recalculating a shorter copy.
- carry decoded `planSteps` across the canonical projector boundary and persist the latest Task List on the open Conversation Segment in the same transaction as its canonical event projection;
- load the persisted Task List into `ConversationSegmentCardView`, so normal projection/redelivery and process restart render the same list;
- classify only complete, trimmed, case-sensitive reserved `<goal_context>`, `<scheduled-task ...>`, and generated AGENTS.md instruction envelopes as system-injected Human records; consume their canonical position without closing the current real segment or creating a visible segment/card.

The 6,000-character limit is the retained source-content budget. The explicit omission marker is additional CardKit text. Existing final payload overflow protection remains the last-resort guard for pathological configured limits.

## User Stories

### SCN-1: Consistent reply title

As a Feishu reader, I see the same `reply to 💬: <message>` title on the first Turn Card and every continuation card. The message is redacted, ANSI-free, normalized to one line, and bounded so the entire title is at most 80 UTF-16 code units. The request is not repeated in the card body.

### SCN-2: Predictable disclosure panels

As a Feishu reader, every collapsible panel starts closed. I can still distinguish running, succeeded, failed, and blocked work from the panel title, icon, animation frame, and border without expanding the details.

### SCN-3: Complete ordinary Thinking

As a Feishu reader, expanding a Thinking panel whose normalized, redacted body is at most 6,000 characters shows the whole body, even when the previous card page lacked room for it. The planner moves the panel to a continuation page rather than shortening it to the previous page's residual budget.

### SCN-4: Explicitly bounded long Thinking

As a Feishu reader, expanding an oversized Thinking panel shows its first 3,000 and last 3,000 normalized source characters, separated by a marker that reports the omitted line and character counts. I never mistake a silent prefix truncation for complete Thinking.

### SCN-5: Canonical ordering survives pagination

When a Thinking panel moves to a continuation page, its canonical item cursor does not advance until the panel is placed. Later Agent, Tool, Status, and final-answer items remain in exact canonical order with no skip, duplicate, or local re-sort.

### SCN-6: Durable Task List projection

When Core records an `update_plan` tool call inside a real Human turn, the latest decoded steps appear in the Turn Card Task List. Reopening SQLite and loading the same card view yields the same ordered labels/states. Replaying an identical plan is idempotent; a changed plan advances the segment view exactly once.

### SCN-7: Reserved system envelopes stay invisible

A complete reserved `<goal_context>`, `<scheduled-task ...>`, or generated AGENTS.md instruction Core Human record creates no Conversation Segment, Human Request, page, or Lark outbox intent and does not close the current real segment. Later canonical output remains attached to that real segment in Core order. Ordinary direct-Herdr text without `submission_id`, including text that merely mentions a tag or asks to read AGENTS.md, continues to create a normal Human Turn Card.

## Implementation Decisions

### Domain Model

The affected bounded context is Card Presentation. Its input is the observed durable `AnswerTimelineItem` sequence and `ConversationSegmentCardView`; its output is a bounded CardKit payload. Conversation Projection remains the authoritative owner of canonical item identity, position, order, and full persisted content.

No entity, aggregate, domain service, persistence rule, or new public value object is introduced. The display copy is a pure presentation value derived per render. The following invariants are enforced by existing presentation modules:

- **INV-1 Canonical authority:** rendering never mutates the timeline item, canonical position, ID, sequence, or persisted Markdown.
- **INV-2 Stable Thinking copy:** one Thinking item produces the same bounded detail copy regardless of the current page's remaining capacity.
- **INV-3 Cursor ownership:** page planning advances past a Thinking item only after its display copy is placed.
- **INV-4 Safe content:** secret redaction, ANSI removal, and Lark Markdown normalization precede head/tail selection, so neither retained end can reveal content that the existing safety boundary removes.
- **INV-5 Durable plan view:** the latest Task List for a segment is SQLite-owned projection state, updated transactionally with the canonical event and never reconstructed from Lark output.
- **INV-6 Reserved-envelope precision:** only a full reserved envelope is non-conversational; missing/extra surrounding content, malformed tags, and ordinary null-submission Human input remain visible Human boundaries.
- **INV-7 Core order authority:** ignoring a reserved visible boundary never sorts, rewrites, or deletes Core JSONL and never advances or closes a real Conversation Segment.

### Architecture

`src/cards/turn-card.ts` continues to own the source-neutral Turn Card shell. Its existing `renderTurnCard` interface remains unchanged; only the bounded header title and removal of the duplicate request body change.

`src/cards/answer-timeline.ts` continues to own conversion from one canonical timeline item to CardKit elements. It owns the private Thinking display-copy policy and the default `expanded` value for Thinking, Tool, Tool Group, and Status panels. Existing exported renderer interfaces remain unchanged.

`src/cards/answer-timeline-page.ts` continues to own item-aware page placement and durable cursor calculation. For Thinking, it plans with the stable display copy rather than asking the renderer to shrink content to residual space. If the copy does not fit after already placed content, the result returns a next cursor pointing to the same item. The following page attempts the same copy with its larger continuation-page budget.

`CanonicalEventProjector` remains the adapter that understands Core `update_plan` tool payloads. `SqliteCapabilityGraph` passes its normalized plan steps as boundary data to `SqliteConversationSegmentStore`; the store owns the latest per-segment Task List projection and exposes it through the existing `ConversationSegmentCardView.taskList` field. A migration adds one JSON-validated nullable column to `conversation_segments`; no new table, public service, or Lark-specific persistence is introduced.

The Conversation Segment store also owns the decision whether a canonical `human_message` opens a visible segment. A small pure classifier recognizes the three reserved system envelope forms before any prior segment is closed or any segment/card/outbox row is created. AGENTS.md classification requires the generated heading plus a complete instructions block and, when present, a complete environment block; a filename mention or partial paste is insufficient. This classifier does not inspect `submission_id` and does not alter the canonical inbox/checkpoint.

Source dependencies remain inward toward domain timeline types and pure runtime Markdown helpers:

```text
domain timeline/view data
          |
          v
pure Card renderers <-> item-aware page planner
          |
          v
plain CardKit payload objects
```

No cards module imports SQLite, coordinators, the Lark SDK, or external runtime state. No new interface or adapter is justified because behavior varies only inside the existing renderer implementation.

### Behavior & Failure Modes

Thinking compaction is deterministic over the normalized and redacted string. Content at or below the source budget is returned unchanged. Oversized content receives one explicit omission marker with counts derived from the removed normalized range.

Page planning preserves the existing indivisible-panel behavior. A Thinking panel that follows already placed content and exceeds the remaining budget causes a continuation at the same item. On a fresh continuation page, the stable display copy is placed and normal planning resumes with the next canonical item.

The configured CardKit payload limit remains authoritative. If an artificially small or pathological limit cannot hold even the bounded panel on an otherwise empty page, existing explicit overflow handling remains responsible for producing a visible bounded failure marker or typed overflow error. The implementation must not loop indefinitely on the same cursor.

Duplicate rendering and repeated updates are pure and deterministic; they produce the same payload for the same view, page cursor, options, and payload limit. No new idempotency identity is required.

Task List updates compare the normalized serialized step list with the persisted value. A change updates `task_list_json` and increments `view_version` in the same SQLite transaction as timeline projection; an identical replay makes no view change. Empty decoded plans persist as an empty list and remove the rendered Task List.

Reserved system Human envelopes return an ignored projection outcome. If a real segment is open it remains open; subsequent non-Human deltas continue into it. If none is open, subsequent output has no invented visible owner and remains ignored by the segment view, while the durable Core inbox/checkpoint still records canonical progress.

### Compatibility & Migration

The presentation portion is render-only. Task List durability adds a nullable JSON column through the existing idempotent SQLite migration path; existing rows read as no Task List and require no backfill. There is no Core JSONL transformation, outbox-contract change, CardKit callback change, or Lark-derived repair. Existing cards change on their next normal render/update; frozen pages remain frozen under current delivery rules.

The change intentionally alters the initial expansion state of running and failed Tool panels. Their status remains visible in existing header text and color. Agent messages and final answers retain their current Markdown pagination behavior.

## Testing Decisions

- `tests/turn-card.test.ts` verifies the identical bounded reply title on page zero and continuation pages, title sanitization/redaction, and absence of duplicated request text in the body.
- `tests/answer-timeline-card.test.ts` verifies that running, succeeded, and failed Tool panels, Tool Groups, Thinking, and Status panels all start collapsed while retaining their current header status evidence.
- The Answer timeline renderer seam verifies short Thinking is complete, long Thinking contains the expected first and last source ranges, the omission marker reports accurate counts, and secrets are redacted before range selection.
- `tests/answer-timeline-page.test.ts` verifies a stable Thinking copy that cannot fit after preceding content leaves the next cursor on that item, appears on the next page without secondary shortening, and does not skip, duplicate, or reorder later canonical items.
- `tests/conversation-segment-store.test.ts` verifies Task List persistence/reload/idempotency and verifies that all three complete reserved envelope forms create no segment/card/outbox row, do not close an open real segment, and do not absorb ordinary direct-Herdr input, mere tag mentions, or normal AGENTS.md read requests.
- A capability-graph integration assertion verifies decoded `update_plan` data crosses into the Conversation Segment store rather than testing a store-only shortcut.
- Focused Red-Green verification runs the three affected test files first. Affected verification then runs TypeScript checking and build. Full delivery verification runs the complete Vitest suite, architecture checks already included in that suite, `git diff --check`, and the repository-required build.

No new concurrency mechanism is introduced; the existing SQLite transaction around canonical event projection owns both timeline and Task List state. A persistence round-trip is required for the new column. Canonical-order tests remain necessary for both page cursor behavior and system-envelope suppression.

## Out of Scope

- Filtering arbitrary XML-like user content or all null-submission Human Messages.
- Changing Core JSONL, durable inbox/checkpoints, timeline item schemas, outbox identity, or delivery lanes.
- Showing unbounded Thinking or splitting one Thinking item into multiple durable timeline items.
- Changing Agent message/final-answer Markdown pagination, Tool result compaction, CardKit actions, or frozen-page mutation rules.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: safe in-place execution, because the task touches distinct card renderer/tests/specification paths and does not overlap the user's existing changes.
- Branch: `main`.
- Starting revision: `95275f7afebc0731f718504a4e344cc30ca82bec`.
- Accounted initial changes preserved outside task scope: modified `TODO.md`; untracked `docs/research/2026-10-02-session-message-jsonl-dependencies.md`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.
- Dependencies were already installed from the locked project state.
- Fresh baseline at the starting revision: `npm test` passed 272 files / 3,884 tests; `npm run typecheck` passed; `npm run build` passed with build ID `sha256:5a37238ee09ad77cf3f6a4aa5992b3fda4df0979d753b0f3b6d7481853c1bae2`; `git diff --check` passed.
- Gate 1 design was originally approved in conversation on 2026-10-05. It was reopened after Task List and reserved-envelope requirements expanded scope. The revised design chose durable segment-owned plan projection plus exact reserved-envelope classification over render-time reconstruction or `submission_id` heuristics.
- The user explicitly authorized completing all known work through deployment without repeated per-step confirmation; that authorization covers the revised Gate 1 design, this revised Gate 2 specification, and the revised Gate 3 ticket set.
- No unresolved design decision or blocker remains.
