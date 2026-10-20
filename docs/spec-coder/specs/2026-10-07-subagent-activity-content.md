# Subagent Activity Content in Answer Cards

## Problem Statement

Core currently emits `agent_activity` with only Subagent identity, model, and
lifecycle state. Swarm therefore renders rows such as started, running, or
completed but cannot show the actual status or completion text carried by a
source lifecycle record. When the Answer page has already frozen, later
Subagent activity must also remain visible without mutating that frozen page.

The requested minimum is to enrich the existing activity event and card item.
This change does not add a second event family, decrypt parent-session
`inter_agent_communication`, scan child session files, or preserve an unbounded
history of Subagent messages.

## Solution

Add optional bounded `content` and `content_truncated` fields to Core's existing
`agent_activity` payload. Core populates them only when the source lifecycle
record already contains plaintext content intended as the Subagent's status or
completion result. It applies the existing redaction boundary before emission.
Source records without available plaintext continue producing status-only
events.

Swarm validates and persists the optional fields through the existing Core
event inbox. A content-bearing activity updates the same per-Subagent Answer
timeline status item with the latest actual content. It does not create a
separate message/card per update. Existing page projection creates or reuses a
continuation page when the prior page is frozen.

## User Stories

### SCN-1: Content-bearing lifecycle update

When Core observes a Subagent lifecycle record that contains plaintext status
or completion content, it emits one `agent_activity` event containing the
normalized identity, model, state, bounded content, and truncation marker.
Swarm shows that actual content underneath the Subagent's status row.

### SCN-2: Status-only update

When the source supplies only a lifecycle state, Core emits the existing
status-only shape. Swarm updates the state and retains the most recent content
already associated with that Subagent instead of erasing it.

### SCN-3: Frozen Answer page

When content arrives after the page containing the prior Subagent status has
frozen, Swarm does not patch the frozen page. It projects the latest state and
content into the existing active continuation page, or creates one through the
normal Answer paging workflow.

### SCN-4: Retry and restart

Replaying the same Core event updates the same timeline item and creates no
duplicate card. Reopening SQLite restores the latest Subagent content from the
persisted timeline item. A newer lifecycle event cannot be overwritten by an
older replay.

## Domain and Invariants

The existing **Agent Activity** remains the canonical lifecycle observation for
one Subagent. `content` is optional presentation-safe evidence attached to that
observation; it is not an Agent Input, command, prompt, tool result, or separate
conversation message. The existing **Answer Timeline Item** remains the durable
card projection.

- **INV-1:** `agent_activity` remains backward compatible when content is
  absent.
- **INV-2:** Core emits only plaintext already available in the lifecycle
  source record; it never exposes encrypted content, spawn prompts, reasoning,
  paths, tool arguments, or tool results through this field.
- **INV-3:** Content is redacted before event identity or persistence and is
  bounded to 16 KiB with an explicit truncation flag.
- **INV-4:** One Subagent has one current status timeline item. A later
  content-bearing activity replaces its displayed content; a status-only event
  retains the last content.
- **INV-5:** Core event identity changes version when content is present, so an
  upgraded replay cannot reuse an older status-only event ID with a different
  payload.
- **INV-6:** Frozen Answer pages are immutable. Late activity uses normal
  continuation-page and per-Pane Delivery Ring behavior.
- **INV-7:** Delivery retries never repeat or synthesize Subagent work.

## Architecture

### Core codec and schema

Extend `ReplyPayload::AgentActivity` with optional `content: String` and
`content_truncated: bool`. The codec may populate these fields from a known
plaintext lifecycle result such as `collab_close_end.status.completed`. It must
not read `prompt`, `encrypted_content`, hidden reasoning, or generic tool
payloads. Empty content is omitted. Content-bearing events use a versioned key
derived from native occurrence identity plus normalized redacted content.

The API schema remains additive. Checkpoint state does not retain message
content; replay derives the same payload and event identity from the same
source record.

### Swarm adapter and projection

Extend both live and persisted Core-event codecs with optional bounded content
and truncation fields. `HerdrEventProjector` keeps the existing stable
Subagent status identity and adds the content to its status timeline delta.
Status-only updates preserve the prior detail. Event order and existing lane
sequence decide which update wins.

`conversation_segment_items` already persists timeline JSON, so no schema
migration or new aggregate is required. Page planning and the prepared delivery
path remain responsible for frozen-page continuation and idempotent Feishu
updates.

### Feishu rendering

The Answer timeline renderer shows the Subagent label/state/model followed by
the latest nonblank content. It uses normal Markdown safety and page budgets;
the Core truncation marker is rendered when present. No standalone Subagent
message card is created.

## Failure and Compatibility Behavior

- Missing content remains a valid legacy `agent_activity` event.
- Malformed, blank, or oversized untrusted content is rejected or normalized at
  the Core boundary; Swarm independently validates the persisted event shape.
- If current TraeX stores a parent-directed message only as
  `inter_agent_communication.encrypted_content`, this minimum design displays
  no content for that record. Supporting every encrypted intermediate message
  requires a later authenticated decryption or child-session aggregation
  design.
- Existing status rows, models, delivery ordering, recovery, and frozen pages
  retain their current behavior.

## Testing Decisions

- Core codec tests cover plaintext completed content, redaction, truncation,
  empty/status-only compatibility, versioned identity, and replay stability.
- Core schema tests cover `agent_activity` with and without the additive fields.
- Swarm adapter and persisted codec tests cover valid, missing, malformed, and
  bounded content.
- Projector/store tests prove content replacement, status-only retention,
  replay idempotency, and restart persistence.
- Answer-page integration tests prove pre-freeze updates patch the active page
  and post-freeze updates use one continuation page without rewriting the
  frozen page.

## Out of Scope

- Decrypting `inter_agent_communication.encrypted_content`.
- Scanning or tailing child-session JSONL from Swarm.
- Showing spawn prompts, reasoning, or arbitrary tool payloads.
- Keeping every historical Subagent message; only the latest content per
  Subagent is projected.
- A new `agent_message` Core event type or standalone Feishu card.
- Restarting the current Herdr server, production-data cleanup, or pushing a
  repository.

## Workspace and Baseline

- Swarm workspace: in-place at
  `/workspace/herdr-agent-swarm`, branch `main`, starting
  revision `596245a991802e709a73e7c7b0afce54b3f2d0c1`.
- Core target: `/workspace/herdr-core`, local `master` at
  `35db6fdbac16fef111076f833acacd37fd424770`.
- Preserved Swarm untracked paths: `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`; preserved Core `.trae/`.
- Fresh baseline evidence: Choice-focused Swarm tests 109/109 plus the
  structured/legacy conflict regression passed; typecheck, architecture check,
  build, and public audit passed. The full suite passed 4100/4104 under two
  workers, and all four timeout cases passed when isolated.
- Design approval: the user selected the minimal existing-`agent_activity`
  approach and approved it on 2026-10-07.

## Approval State

- Gate 1 design: approved.
- Gate 2 written specification: pending user review.
- Gate 3 ticket plan and implementation authorization: not started.
