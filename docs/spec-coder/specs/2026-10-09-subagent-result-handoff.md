# Subagent Result Handoff

## Problem Statement

Core currently emits `agent_activity.state = "completed"` for both ordinary
subagent lifecycle completion and a successful `collab_close_end`. Swarm stores
that lifecycle state in Session Activity and renders it verbatim. As a result,
the Feishu Main Card can show that a Subagent completed, but cannot say whether
its result was actually delivered to the parent/Main Agent.

Lifecycle completion is not evidence of result handoff. Relabeling every
`completed` activity as `returned to main` would therefore make an unsupported
claim. The protocol needs a separate fact whose producer can distinguish the
successful close operation from ordinary lifecycle activity.

## Solution

Extend Core's `agent_activity` payload with one optional additive fact:

```text
result_handoff?: "delivered_to_parent"
```

Core emits that value only when decoding a successful `collab_close_end` whose
normalized lifecycle state is `completed`. The lifecycle remains
`state: "completed"`. Ordinary `sub_agent_activity: completed`, spawn events,
and unsuccessful close outcomes omit the field.

Swarm accepts the optional wire field, preserves it through its internal event
codec, and maps that exact value to the Session Activity display state
`returned to main`. Events without the field retain their existing lifecycle
display, including `completed`.

This is an additive protocol change. It does not change event ordering,
submission behavior, agent execution, result content, Answer timelines, or
delivery recovery.

## User Stories

### SCN-1: Successful result handoff

When Core observes a successful `collab_close_end`, it emits one
`agent_activity` with `state: "completed"` and
`result_handoff: "delivered_to_parent"`. After canonical projection, the
corresponding Subagent row in the Feishu Session Activity section reads
`returned to main`.

### SCN-2: Completion without handoff evidence

When Core observes ordinary `sub_agent_activity: completed`, or when Swarm
reads an older `agent_activity` that has no handoff field, Session Activity
continues to read `completed`. Neither producer nor consumer infers handoff from
the lifecycle state.

### SCN-3: Unsuccessful or incomplete close

Failed, interrupted, blocked, running, or started close activity omits
`result_handoff`. Swarm renders the normalized lifecycle state and never
renders `returned to main`.

### SCN-4: Retry, restart, and exact-turn recovery

The same raw close event retains its existing Core event identity whether it is
decoded live or through exact-turn recovery. Repeated ingestion remains
idempotent. A Core journal row written by an older binary is not rewritten just
to add the optional field, so an already-observed historical event continues
to render `completed`. If an event was genuinely missing and is first decoded
by the new binary during recovery, it may carry the deterministic handoff fact.

## Implementation Decisions

### Domain Model

The affected contexts are Core transcript interpretation and Swarm Session
Activity projection.

- **Agent lifecycle state** remains the existing state machine (`started`,
  `running`, `completed`, `failed`, `interrupted`, `blocked`). `completed`
  describes the child's lifecycle only.
- **Result handoff** is a separate, optional fact. Its sole valid value in this
  change is `delivered_to_parent`, meaning the successful close operation
  delivered the child's result to its parent. It does not mean the parent
  adopted, merged, applied, or agreed with that result.
- Core owns interpretation of TraeX `collab_close_end`; Swarm must not infer the
  fact from content text or lifecycle state.
- Session Activity owns the user-facing translation
  `delivered_to_parent` -> `returned to main`.

INV-1: `result_handoff = "delivered_to_parent"` is valid only alongside
`state = "completed"` and only when produced from successful
`collab_close_end`.

INV-2: Absence of `result_handoff` never implies delivery to the parent.

No new aggregate, repository, domain service, or SQLite column is required.
The existing event payload and Session Activity item state are sufficient for
this bounded additive fact.

### Architecture

ARCH-1: Core extends its public `ReplyPayload::AgentActivity` schema with a
typed optional handoff field. The TraeX codec supplies the value at the
`collab_close_end` decoding boundary and supplies no value for other activity
sources.

ARCH-2: Core's `agent_activity` helper receives the already-decided optional
fact and serializes it. It does not decide handoff from arbitrary text. The
existing `agent-v3` key and digest inputs remain unchanged. This exception is
intentional: handoff is a deterministic additive interpretation of the same
raw event, while preserving identity is required for live/recovery
deduplication across a rolling binary upgrade.

ARCH-3: Swarm's external adapter, persisted-event codec, and internal
`AgentEventPayload` carry only the known optional value. Unknown values fail at
the existing validation boundary rather than becoming display text.

ARCH-4: The Session Activity reducer selects its display state as follows:

```text
resultHandoff == "delivered_to_parent" -> "returned to main"
otherwise                                -> lifecycle state
```

The CardKit renderer remains a presentation-only consumer of the persisted
Session Activity item. Existing stable agent item identity, terminal pruning,
fencing, Main Card outbox reservation, and renderer escaping are unchanged.

Dependencies continue to point from Swarm adapters/codecs toward the internal
event contract, then from the SQLite projection toward the pure card renderer.
Core remains the only source of the handoff fact.

### Behavior & Failure Modes

- A successful close produces both lifecycle completion and the additive
  handoff fact in one event; there is no second event to order or reconcile.
- Ordinary completion, malformed/unsupported close state, and unsuccessful
  close states cannot acquire the fact through fallback logic.
- Duplicate live delivery or recovery of the same event uses the existing
  event identity and Session Activity lane watermark/idempotency behavior.
- Older Core payloads remain decodable because the field is optional. Older
  journal rows remain immutable under the existing `INSERT OR IGNORE` path.
- If Swarm receives a handoff value outside the one-value contract, decoding
  fails closed at the transport boundary. It is not rendered or persisted as
  an arbitrary state.
- Existing content bounds and `content_truncated` rules are unchanged.

### Compatibility & Migration

The public wire spelling is snake case:
`result_handoff: "delivered_to_parent"`. Swarm's internal spelling is
`resultHandoff: "delivered_to_parent"`. Both are optional.

The Agent Events schema version and existing activity key version remain
unchanged. The new fact does not participate in the `agent-v3` digest. A
focused compatibility test must prove that adding the deterministic handoff
fact to the same successful close record does not change its event key/event
ID. This prevents an upgrade from turning one historical raw event into a
second logical event during exact-turn recovery.

No SQLite migration or backfill is performed. Previously persisted Core or
Swarm events without the field retain `completed`. There is no attempt to
retroactively claim handoff from old lifecycle rows.

## Testing Decisions

- **Core codec seam:** extend `agent_events::codec` tests to prove SCN-1 and
  INV-1 for successful `collab_close_end`; prove SCN-2 for ordinary
  `sub_agent_activity: completed`; prove SCN-3 for non-success close outcomes.
- **Core protocol/schema seam:** extend schema serialization tests to prove the
  exact snake-case optional field, valid omission, and round trip.
- **Core identity/recovery seam:** capture the pre-change successful-close
  `agent-v3` key expectation and prove the enriched event retains that key;
  retain journal live/retry/recovery event-ID equality coverage. This is
  separate evidence for ARCH-2, not only an output assertion.
- **Swarm protocol seam:** extend `tests/herdr-events-protocol.test.ts` to prove
  external normalization plus persisted encode/decode round trip, and that old
  payloads without the field still decode unchanged.
- **Swarm projector seam:** extend `tests/herdr-event-projector.test.ts` only as
  needed to prove the optional fact survives the canonical event projection
  path without changing the existing stable agent timeline identity or result
  content.
- **Swarm Session Activity seam:** extend
  `tests/session-activity-store.test.ts` to prove the exact handoff event stores
  `returned to main`, an ordinary completed event stores `completed`, duplicate
  projection remains idempotent, and Main Card delivery is still reserved
  through the existing durable projection path.
- **Card rendering seam:** extend `tests/run-card.test.ts` to prove the Subagents
  row renders `returned to main`, while a legacy row still renders `completed`.
- Run focused tests first, then Core's affected Rust tests and Swarm's affected
  Vitest files, followed by Swarm typecheck/build and both repositories' full
  applicable suites before delivery.

## Out of Scope

- Claiming that the parent merged, adopted, applied, or accepted a result.
- Inferring handoff from `completed`, result content, tool output, or card text.
- Adding a separate handoff event, changing activity lifecycle states, or
  backfilling historical SQLite/Core journal records.
- Changing Answer Card timelines, subagent orchestration, Core JSONL source
  format, event-ring ordering, delivery rings, outbox behavior, or frozen-page
  rules.
- Installation, service restart, production SQLite mutation, real Feishu
  smoke, push, or pull-request creation.

## Further Notes

Gate 1 design, Gate 2 specification, and Gate 3 implementation authorization
are recorded in the active workflow.

Swarm workspace: in-place at `/tmp/herdr-sqlite-r3` on `feat/sqlite-r3`, after
the user-requested rebase onto local `main` at
`aafafdf077d592cd8901838a557ccfd7d39cafee`. The specification starting
revision is `a2c636c73becb8aed9708001d25bb0388316b409`. The worktree was clean;
the two task-related rebase repair commits are `48c77661` and `a2c636c7`.

Core workspace: isolated at `/tmp/herdr-core-result-handoff` on
`feat/result-handoff`, starting from local Core `master` at
`d68122bb784bcc1d950f5e95c06a83189e1ff7e2`. It is used to avoid the
pre-existing user-owned `Cargo.lock` modification and `.trae/` directory in
the original Core checkout.

Fresh prepared-baseline evidence before specification synthesis:

- Swarm focused Human Review, migration, and Session Activity suites:
  109/109 passed.
- Swarm architecture/migration/Segment repair suite: 173/173 passed.
- Swarm `npm run typecheck`: passed.
- Swarm `npm run build`: passed.
- Swarm full suite: 297 files, 4403 tests passed.
- Core
  `cargo test -p herdr --bin herdr agent_events::codec`: 37 passed, 0 failed,
  using Zig 0.16.0 with task-local caches under `/tmp`.

There are no unresolved design decisions or implementation blockers. Gate 2
approval authorizes ticket decomposition only; it does not authorize code
implementation, installation, restart, production mutation, push, or PR work.
