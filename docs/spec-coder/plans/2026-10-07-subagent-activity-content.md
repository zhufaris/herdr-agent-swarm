# Subagent Activity Content Implementation Plan

Specification: [2026-10-07-subagent-activity-content.md](../specs/2026-10-07-subagent-activity-content.md)

## Prepared Workspace

- Swarm workspace: in-place at `/workspace/herdr-agent-swarm`.
- Swarm branch/base: `main` at `f4c237c5ec06a4ec10bae827350facadcc782e92`.
- Core workspace: in-place at `/workspace/herdr-core`.
- Core branch/base: `master` at `35db6fdbac16fef111076f833acacd37fd424770`.
- Mode: serial main-local execution. The user requested Subagent cleanup, so no
  implementation or review Subagent will be created for this task.
- Preserved Swarm user-owned/unrelated paths: `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Preserved Core user-owned/unrelated path: `.trae/`.
- Baseline: Choice-focused Swarm tests 109/109 and the structured/legacy
  conflict regression pass; typecheck, architecture check, build, and public
  audit pass. Full Swarm suite passed 4100/4104 under two workers; all four
  timeout cases passed in isolation. Core final-choice codec tests pass 36/36,
  with `cargo check`, clippy, fmt, and diff checks green.

## Tickets

- [x] **T1: Consume and render bounded Subagent activity content**

  - **What to build:** Extend the Swarm `agent_activity` transport and
    persisted-event shape with optional `content` and `content_truncated`.
    Project the latest content into the existing per-Subagent status timeline
    item, retain it across later status-only updates and restart, and render it
    under the status/model label. Prove late updates use one active continuation
    page without modifying a frozen source page.
  - **Spec references:** SCN-1 through SCN-4; INV-1, INV-3, INV-4, INV-6,
    INV-7; Swarm adapter/projection and Feishu rendering sections.
  - **Dependencies:** None. The additive consumer can ship before Core.
  - **Delegation eligibility:** Technically bounded and inspectable, but the
    request-scoped Subagent cleanup is an execution opt-out.
  - **Delegation mode:** Main-local, serial.
  - **Ownership and implementation path:** `HerdrEventsAdapter` and persisted
    event codec validate boundary data; `HerdrEventProjector` translates it;
    `AnswerTimelineItem` owns latest-content retention semantics;
    `conversation_segment_items` persists the JSON projection; Answer timeline
    rendering owns CardKit presentation; existing page workflow owns frozen
    continuation behavior.
  - **Mutation ownership:** `src/domain/herdr-events.ts`,
    `src/runtime/herdr-events/event-codec.ts`,
    `src/adapters/herdr-events-adapter.ts`,
    `src/runtime/herdr-events/event-projector.ts`,
    `src/domain/answer-timeline.ts`, `src/cards/answer-timeline.ts`,
    `src/store/sqlite/conversation-segment-store.ts`, and nearest focused
    event/projector/card/segment integration tests. The SQLite projection owner
    must apply the same status-detail merge during upsert because replay after
    process restart cannot depend on an in-memory projector cache.
    Documentation may be updated only where the implemented contract requires
    it.
  - **Exclusions:** Core source; database schema migrations; new event types;
    separate Subagent cards; decrypting parent events; child-session scanning;
    spawn prompts, reasoning, and tool payloads.
  - **Isolation:** Safe in-place serial work from the recorded Swarm base.
  - **Concurrency conflicts:** Cannot overlap T2 delivery integration or any
    other mutation of the shared Core event DTO assumptions.
  - **Verification seam:** First add failing adapter/projector/reducer/render
    tests, including content retention and frozen continuation. Then run those
    files, `npm run typecheck`, `npm run architecture:check`, and
    `npm run build`.
  - **Host capacity:** No child capacity required.
  - **Direct-child boundary:** Not applicable; no child will be created.
  - **Acceptance criteria:** Old status-only events remain valid; valid content
    appears below the correct Subagent; status-only updates retain prior
    content; duplicate replay does not duplicate UI; persisted reopen restores
    it; a frozen page remains byte-for-byte unchanged while one continuation
    carries the late update.
  - **Blocked by:** None.

- [x] **T2: Produce redacted Subagent activity content from Core**

  - **What to build:** Extend Core `ReplyPayload::AgentActivity` with optional
    content and truncation fields. Populate them only from supported plaintext
    lifecycle result fields, beginning with `collab_close_end.status` result
    text; apply existing redaction and a 16 KiB bound. Preserve status-only
    output when plaintext is absent. Version content-bearing decoder identities
    so old status-only events cannot collide with the enriched payload.
  - **Spec references:** SCN-1, SCN-2, SCN-4; INV-1 through INV-3, INV-5, INV-7;
    Core codec/schema and failure/compatibility sections.
  - **Dependencies:** T1, so the deployed consumer understands the additive
    field before the producer can emit it.
  - **Delegation eligibility:** Technically bounded and inspectable, but the
    request-scoped Subagent cleanup is an execution opt-out.
  - **Delegation mode:** Main-local, serial.
  - **Ownership and implementation path:** Core codec owns extraction,
    redaction, bounding, and stable identity; API schema owns the additive wire
    shape; journal replay continues to use the normalized decoder output.
  - **Mutation ownership:** `src/agent_events/codec.rs`,
    `src/api/schema/agent_events.rs`, Core schema tests, codec/journal tests, and
    regenerated `docs/next/api/herdr-api.schema.json` if its typed shape changes.
  - **Exclusions:** Decrypting `inter_agent_communication`; reading child
    transcripts; exposing prompt/reasoning/path/tool content; Feishu behavior;
    unrelated agent-event changes.
  - **Isolation:** Safe in-place serial work in Core after T1 is committed.
  - **Concurrency conflicts:** Must not overlap T1 integration or concurrent
    mutation of `ReplyPayload::AgentActivity` and generated schema.
  - **Verification seam:** First add failing codec/schema tests for completed
    plaintext, redaction, truncation, empty/status-only compatibility, v3
    identity, and live/replay stability. Then run the affected Rust tests,
    `cargo fmt --check`, `cargo check --locked`, and clippy with warnings denied.
  - **Host capacity:** No child capacity required.
  - **Direct-child boundary:** Not applicable; no child will be created.
  - **Acceptance criteria:** Supported plaintext completion content is emitted
    exactly once after redaction and bounding; unavailable or encrypted content
    emits no body; old payloads deserialize; enriched events cannot reuse old
    status-only IDs; restart/replay produces identical event identity and data.
  - **Blocked by:** T1.

## Delivery Checks

- Review Swarm and Core diffs independently against the approved specification.
- Run all affected test files and both repositories' required type/build or
  Rust check/clippy/fmt gates.
- Run the full Swarm Vitest suite with bounded worker concurrency; isolate any
  timeout-only failures before classifying them.
- Run Core agent-event and schema suites plus the repository's applicable
  broader verification baseline.
- Run `npm run public:audit` before any future push consideration.
- Do not push, clean production data, stop the active Herdr server, install a
  new release, or restart services without separate authorization.

## Approval State

- Gate 1 design: approved.
- Gate 2 specification: approved with response `A`.
- Gate 3 ticket plan and implementation authorization: approved with response
  `A` after Red evidence added the existing Conversation Segment SQLite
  projection owner to T1 mutation scope.
