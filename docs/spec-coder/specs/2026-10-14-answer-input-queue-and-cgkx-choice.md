# Answer Input Queue and cgkx Choice Recovery

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

When an Answer is still being generated, a later canonical Human Message
currently enters the same session projection path and unconditionally closes the
open prior Conversation Segment. Its active Answer page is then finalized as
"merged into later input" or otherwise rendered stale/gray. Later assistant and
tool events can also be routed through the newest open Segment instead of the
turn that produced them. The new Human Message may therefore appear to replace
the current card, while the Answer being generated loses its remaining output.

The intended behavior is independent Human Message admission with ordered card
delivery: the new input is durable and queued, the working Answer Segment stays
open and keeps receiving exact-turn Core events, and the new Segment gets its
own CardKit delivery intent behind the same Pane scope.

Separately, pane `cgkx` has a missing choice-list presentation. Its TraeX/Core
session began before the `herdr-choice-list` hook was installed and sessions do
not hot-reload hooks. Recent canonical final events contain a native mention but
no `completion_choice`, Action Set, or completion-review outbox card. This is an
operational follow-up: replace/restart that stale TraeX session and verify the
canonical metadata-to-card path after T1.

The live TraeX protocol also exposes the current collaboration tools as
`collaboration__spawn_agent`, `collaboration__wait_agent`, and
`collaboration__interrupt_agent`. The session-activity compatibility translator
currently recognizes only the retired `multi_agent_v1__*` names, so current
Subagent lifecycle events are accepted by Core but never become visible card
activity.

## Solution

Preserve a working prior Segment when a later Human Message is projected. Create
the later Human Message as an independent Segment and page without closing or
superseding the working prior Segment. Route non-terminal assistant, tool,
model, task-list, and goal deltas by the exact canonical `turn_id` first; only
use the existing latest-open fallback for events without an exact turn identity.
Terminal completion already uses the exact Human Message turn fence and remains
unchanged.

The durable outbox and Pane delivery scope serialize the two Segment card
effects. No new queue table or scheduler is introduced. The old Answer page is
not replaced; its existing page revision continues until normal freeze/finish.

## User Stories

### SCN-1: A later Human Message queues without interrupting a working Answer

Given Segment A is `working` with an active Answer page, when Human Message B is
projected, B receives a new independent Segment and page intent while A remains
`working`. A's page is not immediately grayed, finished, dismissed, or
superseded.

### SCN-2: Exact-turn output remains attached to the original Segment

After B is admitted, assistant messages, tool results, model metadata, task
list updates, and goal changes carrying A's exact Core `turn_id` continue to
update A. B's events update B. A's terminal event completes A and does not get
lost or attached to B.

### SCN-3: Pane delivery remains ordered and durable

A and B have independent durable delivery intents in the same Pane scope. A
working Answer delivery is not replaced by B; B waits behind the existing scope
ordering and is recoverable after restart. A failed or retried delivery does not
drop B's input or resubmit either Human Message.

### SCN-4: Existing terminal/supersession behavior remains bounded

When the prior Segment is already terminal or awaiting Human Review, the
existing action invalidation and terminal cleanup rules remain intact. Only a
still-working Answer receives the new non-interrupting behavior.

### SCN-5: A stale cgkx session is identifiable and recoverable

The `cgkx` follow-up records that its session predates the hook installation,
restarts/replaces the TraeX session, and verifies a later final with valid
`completion_choice`, a trusted Action Set, and a delivered completion-review
CardKit payload. No code path infers choice buttons from prose.

### SCN-6: Current collaboration Subagent activity is visible

Given a current TraeX collaboration spawn, wait, or interrupt tool pair, when
the correlated Core events are projected, the owning Primary or Worker session
activity view contains one bounded Subagent item with the correct lifecycle
state and identity. The item is rendered in the existing Answer/Main Card
activity section without exposing private task or result text.

## Implementation Decisions

### INV-1: Working Segment ownership is preserved

Projection of a new Human Message must not close a prior Segment whose state is
`working`. It must not supersede that Segment's Action Set or alter its active
page state. Conversation Projection owns this rule.

### INV-2: Exact Core turn identity routes output

For non-terminal canonical events, the Segment selected by the Human Message
whose canonical inbox event has the same `turn_id` is authoritative. If there is
no exact turn identity, the existing bounded fallback may be used. Ambiguous
exact ownership fails closed rather than attaching output to the newest Segment.

### INV-3: Independent admission is retained

Human Message B remains independently eligible and is never held behind A's
execution state. Queueing applies to durable card delivery order, not Core
submission or canonical event ingestion.

### INV-4: Durable delivery ordering is unchanged

Both Segment page effects use the existing outbox/Panescope delivery ordering,
idempotency and recovery. No direct CardKit update is issued from a coordinator
to bypass the outbox.

### INV-5: cgkx choice is a runtime lifecycle issue

Choice-list activation comes from the TraeX hook and canonical
`completion_choice`; an old CLI session cannot be repaired by restarting only
the Swarm service. The follow-up must replace/restart the named cgkx session and
verify real payloads, not modify production SQLite or infer state from stale
cards.

### INV-6: Multi-agent tool aliases remain source-compatible

The lifecycle translator accepts both the retired `multi_agent_v1__*` protocol
and the current `collaboration__*` protocol. It normalizes only bounded agent
identity and lifecycle state; malformed, cross-session, truncated, or private
content remains fail-closed.

### ARCH-1: Conversation Segment projection owns the transition

The Human Message branch in `SqliteConversationSegmentStore` owns prior Segment
preservation and new Segment creation. A small exact-turn lookup seam is added
inside the store; CardKit and Delivery remain consumers of the resulting view
and outbox intents.

### ARCH-2: Test seam is canonical projection plus real card convergence

Tests exercise `projectCanonicalEvent` with interleaved Human/assistant/tool/
terminal events and `TurnCardWorkflow`/SQLite outbox state. No test trusts card
text as workflow truth or mocks private methods.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1, ARCH-2

Add a failing integration test for A working followed by B Human Message. Assert
A remains working, B has a separate Segment/page, and A's later assistant/tool/
final events remain in A. Assert A's card is not finalized as merged and B's
outbox intent remains independently durable.

Add rejection/compatibility coverage for terminal prior Segments, exact-turn
ambiguity, duplicate Core events, restart/reopen, and existing terminal
supersession behavior. Run focused Conversation Segment, Human Turn Card,
TurnCardWorkflow and outbox tests, then typecheck, architecture check, build,
diff check, and the full suite. The known baseline prepared-delivery claim
failure on clean main is recorded separately and must not be attributed to T1.

For cgkx, perform a read-only pre/post operational verification: compare session
start and hook installation times, replace/restart the stale TraeX session, then
inspect `bridge.db` Core final JSON, `completion_choice_specifications`,
`completion_action_sets`, and `outbound_replies` for a real review card. Do not
claim this follow-up from local parser tests alone.

For Subagent display, add a failing projection test using the live
`collaboration__spawn_agent`, `collaboration__wait_agent`, and
`collaboration__interrupt_agent` event shapes, then run the focused session
activity and card projection suites plus typecheck, architecture check, and
build. Verify that the existing `multi_agent_v1__*` compatibility tests remain
green.

## Out of Scope

- Delaying or rejecting Human Message admission until an earlier turn completes.
- Combining two Human Messages into one Conversation Segment.
- Reordering Core events by Feishu arrival time or card text.
- New queue tables, schema migrations, direct CardKit writes, or bypassing the
  durable outbox.
- Inferring `herdr-choice-list` options from prose.
- Historical cgkx card repair, production SQLite mutation, or restarting any
  pane other than the explicitly named cgkx follow-up.
- Exposing Subagent prompt, tool, or result content beyond bounded identity and
  lifecycle status.

## Further Notes

Gate 1 design A approved on 2026-10-14. Workspace is isolated at
`/tmp/herdr-agent-swarm-answer-input-queue`, branch `fix/answer-input-queue`,
base `ffdb846985a775060c85bc3b17254cc95867b089`; main's existing staged files
are preserved in the original worktree.

Baseline preparation: `npm ci`, `npm run typecheck`, and
`npm run architecture:check` passed; TurnCardWorkflow and Human Turn Card
integration tests passed. Clean main reproduces one unrelated existing failure
in `tests/conversation-segment-store.test.ts` at
"atomically creates the first Working Turn Card from an exact canonical Human
Message" (prepared-delivery claim is null). This failure is not part of T1 and
must remain separately reported.

Operational TODO: restart/replace the stale `cgkx` TraeX session and verify its
choice-list path end to end after the code ticket is delivered.
