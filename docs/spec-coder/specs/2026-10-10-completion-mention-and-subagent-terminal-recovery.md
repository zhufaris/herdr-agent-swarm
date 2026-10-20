# Completion Mention and Subagent Terminal Recovery

## Problem Statement

Two independent gaps leave a completed interaction looking unfinished in the
Feishu Answer Card.

First, a Primary Conversation Segment can durably finish and its presentation
reply can be acknowledged by Feishu, yet its requester mention remains in
`waiting_for_answer`. The immediate ACK callback currently also requires the
page's transient `pending_reply_id` to equal the delivered reply. Normal page
checkpointing clears that pointer, so a lost or late callback has no durable
recovery path even though `outbound_replies.state = 'delivered'` and the
Segment's `presentation_reply_id` prove the visible Answer revision was
acknowledged. A later Human Message can then suppress the still-waiting
obligation without ever sending the native mention.

Second, TraeX can return a child Agent result to its parent as a structured
`response_item` whose payload type is `agent_message`, while emitting only
`sub_agent_activity` states such as `started` and `interacted`. That record is
also used for ordinary child progress messages, so author/recipient identity
alone cannot prove completion. Core already maps the explicit
`collab_close_end` event to canonical terminal `agent_activity`, but the
installed TraeX 0.208.1 runtime does not guarantee that event when an
automatically completed child delivers its final result. Swarm therefore
correctly retains the last canonical state and Session Activity continues to
show the Subagent as `running`; this is not a stale-card or SQLite cache defect.

Production evidence for the mention gap includes Segment
`6724897b-3e44-4710-909f-2ed0ac30fd48`, presentation reply
`26a67410-4b10-4556-97f7-a77d15dc3cae`, and final event
`3a9593befb975a5831e51667698425139f54cbb05e11cb5c9ec58552fcc4e58f`.
The reply was delivered and the page finished at delivered sequence 2, while
`pending_reply_id` was already null and no
`primary-segment-completion:*` reply was created.

## Solution

Use durable authoritative evidence for both repairs.

TraeX collaboration lifecycle will use the existing explicit
`collab_close_end` record as its terminal handoff protocol. The producer must
emit one whenever a child reaches a terminal outcome and its result is handed
to the parent, including automatic completion rather than only an explicit
close operation. Core continues to translate a successful close into the
existing canonical `agent_activity` shape with `state = completed` and
`result_handoff = delivered_to_parent`; failed closes remain failed terminal
activity. `response_item.agent_message` remains a message only and never
changes lifecycle state.

Swarm will treat the Segment's stable `presentation_reply_id` joined to a
durably delivered outbound reply as the ACK proof for releasing a completion
mention. `conversation_segment_pages.pending_reply_id` remains only an
in-flight pointer and is not required during recovery. The existing immediate
ACK path stays fast, while Segment/page reconciliation and startup recovery can
retry the same release from SQLite evidence. Releasing the obligation,
reserving the text notification, and recording the released state remain one
transaction with the existing deterministic idempotency key.

Swarm will also make terminal Subagent projection metadata-preserving: when a
terminal `agent_activity` omits display name or model, the existing values for
that stable `agent_id` remain visible. Agent tool activity stays in the Answer
Timeline; `agent_activity` stays exclusively in Session Activity.

## User Stories

### SCN-1: Explicit child terminal handoff closes Session Activity

Given a child identity established by structured lifecycle records, when TraeX
accepts that child's terminal result for its parent, TraeX emits one explicit
`collab_close_end` carrying the stable child thread identity and terminal
outcome. Core emits completed `agent_activity` with
`result_handoff = delivered_to_parent` for a successful handoff. Swarm updates
the existing Subagent row from `running` to `returned to main`.

### SCN-2: Unproven messages do not create terminal state

No `agent_message`, whether an ordinary progress message or a final response,
completes a Subagent. Missing, malformed or unsupported terminal lifecycle
records fail closed. Core never interprets `Message Type: FINAL_ANSWER`, the
presence or absence of `encrypted_content`, or other body structure/text as
lifecycle evidence.

### SCN-3: Duplicate terminal evidence converges

Repeated ingestion of the same terminal event is idempotent. Duplicate
terminal evidence for the same child converges on the same stable Session
Activity item and cannot regress it to `running` or create another visible
Subagent.

### SCN-4: Terminal events preserve known identity metadata

When the completed event omits display name or model, Swarm keeps the last
known nonempty display name and model for that `agent_id`. An absent field is
not an instruction to erase previously projected metadata.

### SCN-5: Timeline boundaries remain unchanged

Collaboration and Agent tool calls and results continue to appear in the
Answer Timeline. Canonical `agent_activity` updates only the latest Subagent
state in Session Activity and is not added to the Answer Timeline.

### SCN-6: Immediate delivered ACK releases the mention

When the exact Segment presentation reply becomes `delivered`, the delivery
transaction validates the Segment, page, final event, requester, Binding and
payload evidence, reserves one native mention, and marks the obligation
released. Its idempotency key is
`primary-segment-completion:<bindingId>:<bindingGeneration>:<segmentId>:<finalEventId>`.

### SCN-7: Recovery releases after the in-flight pointer is cleared

If page checkpointing has already cleared `pending_reply_id`, reconciliation
finds the still-waiting obligation and the exact delivered
`presentation_reply_id`, then performs the same transactional release. A
service restart or lost in-process callback does not require another Answer
delivery and does not lose the mention.

### SCN-8: Invalid or incomplete ACK evidence fails closed

A pending, rejected, mismatched, stale-generation, wrong-page, wrong-final,
wrong-requester, wrong-Binding, or payload-incompatible reply does not release
the obligation. The release attempt returns a structured refusal reason for
logs/tests/reconciliation rather than an uninformative boolean.

### SCN-9: Retry and restart remain exactly-once at the durable boundary

Repeated ACK callbacks, repeated reconciliation, and restart recovery converge
on one released obligation and at most one notification outbox entry. They do
not repeat the Agent turn, patch a frozen Answer Page, or send outside the
ordinary outbox retry contract.

## Implementation Decisions

### Domain Model

The affected Swarm contexts are Conversation Projection and Delivery and
Operations. Core transcript interpretation supplies canonical facts to those
contexts. The Subagents shown in Session Activity are TraeX collaboration
activity; they are not Swarm Worker Runtime entities and this change does not
alter Worker generation or Worker Task ownership.

The relevant model elements are:

- **Child terminal handoff:** an explicit TraeX `collab_close_end` lifecycle
  record for one stable child thread. It is distinct from child-to-parent
  message delivery and cannot be reconstructed from message content.
- **Result handoff:** the existing optional canonical fact
  `delivered_to_parent`, valid only with completed lifecycle state and proven
  structured child-to-parent delivery.
- **Session Activity Subagent item:** the latest visible projection for one
  stable `agent_id`. Terminal state is monotonic for this repair, and omitted
  optional metadata preserves known values.
- **Completion notification obligation:** the durable decision that one
  requester mention is owed for a completed Primary Segment.
- **Presentation ACK evidence:** the Segment/page's stable
  `presentation_reply_id` plus the matching delivered outbound reply and the
  existing owner, generation, final-event, requester, page and payload fences.
  The page's `pending_reply_id` is not part of this durable proof.

INV-1: Only an explicit terminal collaboration lifecycle record may complete a
Subagent. `agent_message`, its author/recipient, `encrypted_content`, body text,
timeouts and parent Turn completion are never lifecycle evidence.

INV-2: A terminal activity update targets the same stable `agent_id`, cannot
regress to a nonterminal display through duplicate/later evidence, and cannot
erase an existing display name or model merely because the new event omits it.

INV-3: Agent tool calls/results remain Answer Timeline facts; `agent_activity`
remains a Session Activity-only fact.

INV-4: A completion mention is eligible only after the exact presentation
reply is durably delivered and all existing ownership/content fences match.

INV-5: `pending_reply_id` is an in-flight coordination pointer. Clearing it at
checkpoint cannot invalidate previously durable delivery evidence or prevent
recovery.

INV-6: Obligation release, notification outbox reservation, and released-state
recording are atomic and use the stable completion-notification identity.

No new Swarm aggregate is introduced. The existing obligation, Segment/page,
outbound reply, Session Activity item, and transaction boundaries remain the
authoritative model.

### Architecture

ARCH-1: TraeX owns the terminal lifecycle decision. After accepting a child's
terminal result for its parent, its collaboration producer emits
`event_msg.payload.type = "collab_close_end"` with a stable terminal event
identity, the child thread identity, optional display name, and an explicit
completed or failed status. Replays retain the same event identity.

ARCH-2: Core's TraeX codec continues to consume `collab_close_end` at the
structured adapter boundary and emit the existing
`AgentActivityState::Completed` plus
`AgentActivityResultHandoff::DeliveredToParent` contract for success. Ordinary
`response_item.agent_message` records stay outside lifecycle projection. No
new Core event enum or Swarm SQLite schema is required.

ARCH-3: Swarm's canonical event projector continues routing tool activity to
the Answer Timeline and `agent_activity` to Session Activity. The Session
Activity reducer performs an idempotent, metadata-preserving update of the
existing Subagent item and retains current owner/session fencing and bounded
item rules.

ARCH-4: Delivery ACK handling remains the low-latency trigger. The completion
notification release predicate uses the immutable presentation reply identity
and `outbound_replies.state = 'delivered'` as ACK authority, then validates the
existing projection and ownership evidence. It does not require the mutable
page `pending_reply_id` after delivery.

ARCH-5: The same release operation is callable by the existing bounded
Segment/page convergence and startup-recovery paths for waiting obligations.
Its result distinguishes released/already-converged outcomes from structured
not-ready or mismatch reasons, allowing retries and diagnostics without
weakening the predicate.

ARCH-6: SQLite owns notification recovery and atomicity. CardKit/Lark remains
only the delivery target; no card text is read back as workflow evidence.
Concrete recovery scheduling stays in existing startup/convergence composition
rather than being added to a renderer or coordinator.

Source dependencies remain inward: Core's transport decoder produces the
canonical event contract; Swarm's event adapter/projector feeds SQLite-owned
view and obligation transitions; the outbox adapter delivers the immutable
notification. Renderers consume projected state and do not decide lifecycle or
release eligibility.

### Behavior & Failure Modes

- Missing or malformed `collab_close_end` evidence fails closed. Core does not
  substitute a nearby `agent_message` or infer terminal state from ordering.
- Duplicate canonical terminal ingestion remains guarded by stable event
  identity and existing lane checkpoints.
- Terminal projection without model/name preserves prior values; an explicit
  later nonempty value may still update them under existing rules.
- Immediate mention release can lose its process-local callback without losing
  correctness because the waiting obligation, presentation identity and
  delivered reply remain queryable.
- Reconciliation can run repeatedly. A unique deterministic idempotency key
  and compare-and-set obligation transition prevent duplicate outbox entries.
- A structured refusal is observational; it does not mutate an obligation or
  relax a failed fence. Retryable not-ready evidence remains waiting, while
  owner/generation/content mismatches remain visible for diagnosis under
  existing recovery policy.
- Notification delivery failure does not roll back the completed Answer or
  rerun Core work. Ordinary outbox retry/dead-letter behavior remains in force.

### Compatibility & Migration

Core reuses the additive `agent_activity.result_handoff` field already present
in the protocol. Existing consumers and historical records without the field
remain valid. No decoder checkpoint migration or historical transcript rewrite
is required.

The load-bearing compatibility requirement is producer-side: TraeX must make
`collab_close_end` a guaranteed outcome of automatic terminal result handoff.
The installed runtime is an internal binary (`traecli 0.208.1`) and no TraeX
runtime source checkout is available in the prepared workspaces. Core and
Swarm consumer work can be verified independently, but end-to-end terminal
recovery cannot be declared complete until an upstream build providing that
guarantee is available and observed.

Swarm requires no SQLite schema migration: the necessary
`presentation_reply_id`, obligation, outbound delivery state, and stable
idempotency fields already exist. Historical waiting obligations that still
have complete matching evidence become eligible for bounded startup or
periodic convergence; no bulk backfill or direct production database edit is
performed.

The existing public card layout and wording remain compatible. A Subagent can
move from `running` to the already-supported `returned to main` display, and a
separate native mention can now be emitted after durable Answer ACK as already
intended.

## Testing Decisions

- **TraeX producer contract:** upstream tests prove automatic successful child
  result delivery emits one stable `collab_close_end`, automatic failure emits
  an explicit failed terminal record, replay preserves the event identity, and
  ordinary progress messages emit no terminal record.
- **Core codec preservation:** retain realistic `collab_close_end` success,
  failure, duplicate and malformed fixtures. Add `agent_message` fixtures that
  prove ordinary and final-looking messages are ignored as lifecycle facts and
  cannot emit terminal activity.
- **Swarm Session Activity Red/Green:** extend
  `tests/session-activity-store.test.ts` with running-to-terminal projection
  where terminal metadata is absent. Assert the same item becomes terminal,
  preserves display name/model, stays terminal on duplicate/later evidence,
  and reserves the existing projection delivery only when visibly changed.
- **Event routing preservation:** use the existing projector/protocol seams to
  prove Agent tool calls/results remain in the Answer Timeline while
  `agent_activity` remains Session Activity-only.
- **Mention release Red/Green:** extend
  `tests/conversation-segment-store.test.ts` with a delivered presentation
  reply whose page has already checkpointed and cleared `pending_reply_id`.
  Prove one notification is reserved with the stable key and the obligation is
  released.
- **Mention refusal and atomicity:** cover pending/wrong/stale/mismatched reply
  evidence, structured refusal results, duplicate ACK/reconciliation, and
  transaction rollback so no partial released state or duplicate outbox entry
  can survive.
- **Startup/convergence integration:** prove a persisted waiting obligation and
  delivered presentation reply are recovered after reopening the store or
  running the existing bounded startup converger, without replaying the Answer
  or Agent input.
- Run Core's focused codec/schema tests and Swarm's focused Segment, Session
  Activity, projector and startup convergence tests first. Then run Swarm
  typecheck/build and both repositories' applicable full suites before
  delivery.

## Out of Scope

- Inferring completion from timeouts, parent Turn completion, card text,
  terminal prose, `Message Type: FINAL_ANSWER`, `encrypted_content`,
  author/recipient direction, or arbitrary JSONL content.
- Changing TraeX collaboration scheduling, spawn policy, explicit close
  commands, Swarm Worker Runtime, Worker cards, or parent-result acceptance
  semantics. The required automatic terminal-event emission is in scope; the
  surrounding scheduler and result behavior are not.
- Moving `agent_activity` into the Answer Timeline or removing collaboration
  tool calls/results from it.
- Replaying Agent Input, patching frozen Answer Pages, weakening owner/session
  fences, or treating CardKit state as workflow authority.
- Bulk production data cleanup, direct SQLite repair, installation, service
  restart, live Feishu mutation/smoke, push, pull request, or deployment.

## Further Notes

Gate 1 was reopened after TDD showed that `response_item.agent_message` carries
both progress and final messages. The revised Gate 1 selected an explicit
terminal protocol: TraeX guarantees `collab_close_end`, Core consumes it, and
message records never imply lifecycle. Swarm supplies monotonic projection;
Swarm projects it idempotently; completion mentions use durable ACK evidence
and recoverable release. This specification is pending Gate 2 approval.

Swarm workspace is in-place at
`<repo>`, branch `main`, starting
revision `e6c7d4ead6a6ec7ee6f0400c82eaadebd2d26518`. In-place planning is safe
because this artifact has a unique path and implementation ownership does not
overlap the pre-existing user changes. Initial changes to preserve and exclude
are modified `AGENTS.md` and untracked `.tmp-build/`,
`docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md`.

Core verification workspace is the existing isolated worktree
`/tmp/herdr-core-result-handoff`, branch `feat/result-handoff`, at starting
revision `2c0bff83eef7159bba99f5dec82b36ccc4866105` (also current local
`master`). The revised design requires no Core implementation change because
the explicit `collab_close_end` mapping already exists. This checkout supplies
consumer-preservation evidence while remaining isolated from the original
Core checkout's user-owned `Cargo.lock` and `.trae/` changes. The isolated
worktree is clean; its `Cargo.lock` is excluded from task mutation.

Fresh prepared-baseline evidence:

- Swarm focused Segment and Session Activity tests: 68/68 passed.
- Swarm `npm run typecheck`: passed.
- Swarm `npm run build`: passed.
- Swarm full suite: 298 files and 4430 tests passed.
- Core `cargo test --locked agent_events::codec`: 37 passed and 0 failed,
  using the existing Zig 0.16.0 binary and task-local caches under `/tmp`.
- Core's temporary Cargo lockfile reordering from the first unlocked baseline
  invocation was restored exactly; `git diff --exit-code -- Cargo.lock` passes.

There are no unresolved design decisions or implementation blockers. Gate 2
approval authorizes ticket decomposition only. It does not authorize code
implementation, commits, installation, restart, production mutation, push, or
pull-request work.
