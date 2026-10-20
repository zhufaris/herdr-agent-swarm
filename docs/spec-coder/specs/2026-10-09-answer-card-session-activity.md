# Answer Card Subagent Activity and Human Review Repair

## Problem Statement

The current Primary Answer Card can show Session Activity, but the projection
and delivery integration has three correctness defects:

1. when a page is replanned without Session Activity before freezing,
   `TurnCardWorkflow` can persist the cursor calculated from the earlier
   activity-bearing plan rather than the cursor represented by the frozen
   card;
2. Session Activity invalidation can select an older Primary final card when a
   newer Conversation Segment exists but does not yet have a deliverable page;
3. Capability Graph compares Session Activity fingerprints outside the
   projection store, so an event reported as `ignored` can still trigger an
   Answer Card delivery when it removes stale producer state.

The section also exposes model, turn, goal, task, Agent, and tool facts. The
intended Answer Card surface keeps the existing Goal, adds a `Subagents`
section directly below Task List using the same compact/collapsible timeline
style, and retains Compaction as a separate compact status below Subagents.
Tools are not displayed through Session Activity; canonical Agent tool calls
remain visible in the Answer Timeline.

Human Review has a separate inconsistency. The completion mention and choice
buttons are derived independently, so a completion without a valid canonical
`completion_choice` can render a mention with no buttons. When choices do
exist, the mention is currently rendered before the action controls rather
than below them.

Canonical final Markdown can also contain the requester placeholder
`@_user_1`, but today it remains literal text. It is neither converted to a
trusted CardKit mention nor followed by a native Feishu notification, so the
requester receives no notification.

The repair must preserve frozen-card immutability, exact current-segment
selection, durable outbox delivery, projection fencing, and existing Core event
authority. It must not expand into a PreparedDelivery, Delivery Ring, or Core
protocol redesign.

## Solution

Deepen the existing projection interfaces rather than add another revision
stream:

- Session Activity supplies an Answer Card view containing only ordered
  Subagent status and Compaction count. The card renders `Subagents` directly
  below Task List and Compaction below it. The existing Conversation Goal stays
  visible. The projection store owns the visible-state comparison and returns
  both canonical projection outcome and explicit `visibleChanged` evidence.
- Capability Graph requests Answer Card invalidation only when
  `visibleChanged` is true; it no longer reconstructs presentation policy from
  before/after reads.
- Conversation Segment invalidation selects the newest fenced Primary segment
  first, then verifies that exact segment has a mutable/deliverable current
  page. It never falls back to an older final card.
- `TurnCardWorkflow` persists the cursor from the exact render plan whose card
  is reserved. Frozen and continuation plans therefore share no cursor from an
  abandoned plan.
- Human Review exists only when a valid final canonical
  `payload.completion_choice` was persisted for the exact current owner. Its
  visible order is question, buttons, then requester mention. Missing or
  invalid choice metadata produces neither buttons nor a Human Review mention;
  an independent final requester mention request remains possible.
- An exact `@_user_1` marker in canonical final Markdown outside code is a
  bounded request to mention the current segment's trusted Feishu requester.
  The marker is removed from answer Markdown, rendered once as a native mention
  immediately after the Answer Timeline, and releases one idempotent native
  notification only after the exact card revision is acknowledged. It never
  supplies or selects an `open_id`.
- Answer Timeline owns canonical `tool_call`/`tool_result` history for every
  tool category, including collaboration/Agent tools. Session Activity owns
  only the latest Subagent lifecycle state, so `agent_activity` updates
  `Subagents` without adding a duplicate Answer Timeline item. `update_plan`
  remains represented by Task List rather than a duplicate tool row.

No SQLite schema migration or historical backfill is required. Existing
Session Activity rows remain valid internal projection data; only the Answer
Card view and its visible fingerprint are narrowed.

## User Stories

### SCN-1: Subagent activity on the current Primary Answer Card

Given the latest fenced Primary Conversation Segment has a current mutable
page, when a visible Subagent is dispatched, changes state, or terminates, the
Answer Card renders a compact `Subagents` section directly below Task List.
The section uses the Task List's compact, collapsible timeline language and
shows only Subagent entries and their status.

The existing Goal remains visible before Task List. Compaction remains visible
as a separate compact status below Subagents. Each Subagent entry includes its
optional `agent_activity.model`; standalone Primary model, turn, token/context,
task projection duplication, and tool facts—including running/completed `exec`
rows—do not appear in this activity presentation. An empty Subagent view
renders no `Subagents` section.

### SCN-2: Visible-change projection semantics

Each canonical event produces:

```text
{
  outcome: "projected" | "duplicate" | "stale" | "ignored",
  visibleChanged: boolean
}
```

A visible Subagent state or Compaction-count change returns
`visibleChanged: true`. Cleanup of a terminated or stale producer also returns
`visibleChanged: true` when it removes a visible Subagent, even when the input
event itself has no visible payload; that visible cleanup is classified as
`outcome: "projected"`. Duplicate, stale, ignored, or projected events that
leave Subagents and Compaction unchanged return `visibleChanged: false` and
schedule no Answer Card delivery.

### SCN-3: Newest-segment selection

When a newer fenced Primary Conversation Segment exists, Session Activity
invalidation targets only that segment. If that exact segment has no
deliverable current page, invalidation is a no-op. It must not search backward
and update an older final card.

Worker segments, detached or superseded bindings, stale binding generations,
stale session epochs, and non-current Primary segments cannot receive the
live view.

### SCN-4: Pagination and frozen cursor consistency

The current page is initially planned with live Subagent activity. If it
overflows, the page to freeze is replanned without activity, and its card plus
persisted cursor both come from that activity-free plan. The continuation page
starts at that exact persisted cursor and is planned with the latest activity.

If removing activity makes all remaining canonical timeline content fit, the
page is still frozen at the end-of-timeline cursor and a continuation page is
created for the live Subagent section. This keeps the frozen page immutable
and maintains the invariant that only the current page owns live activity. A
restart may repeat an idempotent reservation but must neither skip nor replay
canonical timeline content.

Historical-page recovery, late-item repair, prior completed Turns, and Worker
Turn Cards omit live Session Activity.

### SCN-5: Choice-gated Human Review

Given an eligible Primary completion with a valid persisted canonical
`completion_choice`, its current final Answer Card renders:

```text
Answer Timeline
Human Review question
ordered choice buttons (including the existing system Ignore action)
requester mention
Goal
Task List
Subagents
Compaction
```

The mention is rendered only as part of the same valid choice-backed Human
Review state. If the choice is missing, invalid, stale, belongs to another
owner/generation, or fails to persist, the card renders no Human Review
question, no fallback buttons, and no Human Review mention. An independent
final requester mention request is unaffected. The system does not fabricate a
generic choice list.

### SCN-6: Duplicate, failure, and recovery behavior

Repeated convergence for an already reserved presentation version is
idempotent. A crash after a visible invalidation but before delivery remains
recoverable from SQLite. Pending delivery is not bypassed, frozen pages are not
patched, and no failure retries the Agent turn or reinterprets Lark state as
projection truth.

### SCN-7: Final-message requester mention

Given canonical final Markdown contains the exact token `@_user_1` outside an
inline or fenced code span, and the segment has a trusted Feishu requester,
the token is consumed as presentation metadata rather than shown literally.
The final Answer Card renders one native requester mention immediately after
the Answer Timeline. After that exact card revision is durably acknowledged,
the Outbox reserves one native Feishu text mention so the requester receives a
notification.

Repeated tokens in the same final message, replayed projection, retry,
restart, or replacement delivery still produce one mention row and at most
one notification for the stable segment/final-message identity. Tokens inside
code, tokens in commentary/non-final events, unknown forms such as
`@_user_2`, and Agent-supplied raw Feishu IDs are ordinary text and cannot
create a mention or notification.

If the same completion also has valid Human Review choices, one action block is
rendered immediately after the Answer Timeline in the established question,
buttons, mention order and one Human
Review notification is released; the final-message request does not create a
second notification. Without a valid choice, the final-message marker can
still create its own mention row after the Answer Timeline and completion
notification, but it creates no Human Review question or buttons. If no
trusted Feishu requester exists, the marker is removed without mention or
notification.

### SCN-8: Tool history and latest Subagent state remain distinct

For a canonical Agent turn, every supported `tool_call` and matching
`tool_result` appears in the Answer Timeline, including collaboration tools
such as `collaboration__list_agents` and `collaboration__followup_task` and
ordinary commands such as `exec`. The result updates the stable tool item
rather than creating a second logical call.

`agent_activity` does not create another Answer Timeline status item. It only
updates the stable Subagent entry in Session Activity, where the latest state
and optional model are displayed. `update_plan` continues to update Task List
without adding a redundant tool item.

## Implementation Decisions

### Domain Model

The affected contexts are Session Activity Projection, Conversation
Projection, and Answer Card Presentation.

- Session Activity Projection remains the authority for canonical activity
  state and producer fences. Its Answer Card display model is a derived
  Subagent-and-Compaction view; existing stored facts need not be deleted.
- Conversation Projection remains the authority for latest Primary segment,
  page lifecycle, canonical timeline cursor, final state, completion choice,
  and presentation invalidation.
- Answer Card Presentation remains pure: it accepts already-authorized view
  data and never reads SQLite, Herdr, Core, or Lark.

The term **visible change** means a change to the Answer Card's Subagents or
Compaction presentation after all projection work for one canonical event,
including producer cleanup. It does not mean merely that a database row or
checkpoint changed.

The term **Human Review** means a valid persisted choice specification and its
renderable actions for one exact owner/generation. A requester mention without
that choice is not Human Review.

The term **final requester mention request** means the exact `@_user_1` marker
in canonical final Markdown outside code. It carries no identity. The trusted
requester identity comes only from the fenced segment's canonical Human actor
and binding route.

INV-1: At most one Answer Card page per Primary binding displays live Subagent
activity: the current page of the newest fenced Primary segment.

INV-2: A frozen page is never reserved or patched for live activity, and its
persisted cursor describes the exact card content reserved for that page.

INV-3: Only a visible Subagent-state or Compaction-count change can invalidate
an Answer Card for activity. Internal projection/checkpoint changes alone
cannot.

INV-4: Latest-segment selection precedes page eligibility. Page filtering can
turn the result into no-op but can never choose an older segment.

INV-5: A Human Review action block implies a valid persisted choice/action set for
the same owner, generation, and final card. Missing choices imply no Human
Review question or buttons; they do not suppress an independently requested
final requester mention.

INV-6: A final-page display refresh does not change the terminal state of its
Conversation Segment or repeat Agent input.

INV-7: A final requester mention resolves only to the trusted requester of the
same fenced segment. Assistant text cannot select an arbitrary Feishu identity.

INV-8: One stable segment/final-message identity releases at most one requester
notification after acknowledgement of a card revision containing its native
mention. Human Review and final-message requests coalesce to one notification.
The Human Review/mention block immediately follows the Answer Timeline and
precedes Goal, Task List, Subagents, and Compaction.

INV-9: Answer Timeline records canonical tool history while Session Activity
records current Subagent state. A collaboration tool call is never hidden only
because its descriptor category is `Agent`, and an `agent_activity` lifecycle
event is never duplicated into the Answer Timeline.

### Architecture

ARCH-1: Narrow the Session Activity card display type to ordered Subagent status
entries plus Compaction count. Render `Subagents` immediately after Task List,
reusing its timeline visual pattern and collapsible behavior, then render a
compact Compaction status. Do not render a `Session Activity` heading. Keep the
existing Conversation Goal before Task List. Do not expose tool rows—including
running or completed `exec` entries—or standalone Primary model, duplicated
goal/task, turn, or token/context facts through this activity contract. The
optional model belongs to its Subagent entry and is escaped with the same
untrusted label/state boundary.

ARCH-2: `SessionActivityStore.projectCanonicalEvent` returns a typed result:

```text
SessionActivityProjectionResult = {
  outcome: "projected" | "duplicate" | "stale" | "ignored";
  visibleChanged: boolean;
}
```

The store computes the Subagent-and-Compaction visible fingerprint within the
same projection transaction or consistency boundary that applies the event and
stale-producer cleanup. It classifies visible cleanup as a visible projection
result. The Capability Graph consumes `visibleChanged` directly and does not
load and compare Session Activity snapshots itself.

ARCH-3: The invalidation query first resolves the latest fenced Primary
Conversation Segment for the binding/generation/session epoch. A second check
determines whether that exact segment has a current page eligible for
invalidation. The query returns no target when the latest segment lacks such a
page; ordering is never performed over a page-prefiltered segment set.

ARCH-4: Planning and reservation use one `PlannedTurnCard` boundary. For a
normal page, the reserved card and global cursor come from the activity-bearing
plan. For a page being frozen, both come from the activity-free replan. The
continuation page starts from the frozen plan's global cursor, including the
end-of-timeline case, and independently plans the live activity-bearing card.

ARCH-5: Human Review render state is choice-gated. Completion-choice validation
and persistence occur before a completion mention becomes eligible, or the
read contract derives mention eligibility only from the successfully persisted
choice/action state. The unified completion-block state may independently
carry `final_request`, but it cannot label that state as Human Review or add
buttons without a choice. The pure renderer emits the choice question and
buttons before the mention.

ARCH-6: Conversation Projection recognizes `@_user_1` only while reducing a
canonical `channel: "final"` message. A bounded Markdown-aware extractor ignores
inline/fenced code, removes recognized occurrences from visible answer text,
and persists the resulting mention intent by creating the existing completion
notification obligation for that segment/final event under the existing owner
fence. Identity resolution uses the trusted canonical Human actor/binding data;
the token never contains an ID.

ARCH-7: The Answer Card read model exposes one completion-block mention state
whose reason is `human_review`, `final_request`, or both. The renderer emits at
most one native `<at id=trusted-open-id></at>` mention immediately after the
Answer Timeline. When Human Review is present, it follows the question and
ordered buttons; otherwise it is the only completion-block row. Goal, Task
List, Subagents, and Compaction follow that block. Raw answer Markdown never
directly injects a trusted mention tag.

ARCH-8: Completion notification release remains ACK-gated and uses the durable
Outbox. Its stable idempotency identity includes the segment and canonical
final-message identity. If Human Review and final mention intent coexist, the
existing Human Review notification wins and consumes the shared notification
obligation; otherwise a completion notification is emitted. Delivery retry
never recreates the Agent turn or a second notification.

ARCH-9: Preserve the existing dependency direction:

```text
Core canonical event
  -> SQLite Session Activity / Conversation projections
  -> typed projection result and current-segment invalidation
  -> TurnCardWorkflow planning
  -> pure CardKit rendering
  -> durable Outbox / Delivery Ring
```

No coordinator or renderer independently infers canonical choice validity,
segment currentness, requester identity, mention intent, or visible projection
change.

ARCH-10: `HerdrEventProjector` maps every projected tool descriptor category to
an Answer Timeline tool delta, while retaining the existing `update_plan`
special case that feeds Task List. It does not map `agent_activity` to a
timeline delta. The independent Session Activity projector remains responsible
for reducing `agent_activity` to one latest Subagent row; no schema or Core
protocol change is introduced.

### Behavior and Failure Modes

- Missing or empty Subagent activity omits `Subagents`; Compaction and the
  existing Goal retain their independent visibility rules.
- Producer cleanup that visibly removes a Subagent schedules exactly one
  current-card convergence; invisible cleanup schedules none.
- A stale fence fails closed rather than borrowing current pane activity for an
  old Turn.
- A newer page-less segment blocks fallback to every older segment; periodic
  ordinary convergence remains responsible for creating its page.
- A failed/pending card delivery retains existing retry, quarantine,
  bounded-degradation, checkpoint, and audit behavior.
- A final card with no valid choice completes normally without Human Review UI
  or Human Review notification. Choice validation failure is not replaced with
  generic controls; an independent valid final requester mention request may
  still produce its completion mention and notification.
- An untrusted/missing requester, token inside code, non-final token, unknown
  alias, or raw Agent-supplied Feishu ID produces no native mention and no
  notification.
- Notification reservation occurs only after ACK evidence proves the delivered
  card payload contains the trusted native mention for that stable intent.
- Existing action callback fencing and idempotency remain unchanged.
- Unknown or unmatched tool results retain existing ignore behavior. Removing
  duplicate `agent_activity` timeline rows does not remove or rewrite prior
  frozen cards; it affects newly projected mutable/current cards only.

### Compatibility and Migration

No Core protocol, canonical event schema, event ring, delivery ring, or outbox
contract change is required. Existing Session Activity rows and non-Subagent
projection facts may remain stored for other consumers; they are excluded from
this Answer Card view and fingerprint.

No historical cards are backfilled or rewritten. Existing frozen pages remain
immutable. Public event payloads and completion-choice schema remain
compatible. The existing completion notification obligation and stable
segment/final-event evidence represent mention intent; no SQLite schema
migration is required and no intent is inferred from historical text.

## Testing Decisions

- **Subagent-only rendering (SCN-1, ARCH-1):** prove active and terminal
  Subagents render under Task List with the same compact/collapsible timeline
  style and the `Subagents` label; empty activity is omitted. Prove the existing
  Goal remains before Task List and Compaction renders below Subagents. Prove
  the optional Subagent model renders in its entry while standalone Primary
  model, duplicated goal/task, tool (including running/completed `exec`), turn,
  and token/context facts do not render through Session Activity. Prove shared
  Main/Pane consumers also use the narrowed Subagent/Compaction display
  contract without a `Session Activity` heading.
- **Projection result (SCN-2, INV-3, ARCH-2):** assert both `outcome` and
  `visibleChanged` for visible Subagent transitions, invisible events,
  duplicates, stale events, and stale-producer removal caused by an otherwise
  ignored event. Prove Capability Graph schedules only on `visibleChanged`.
- **Latest segment (SCN-3, INV-4, ARCH-3):** create an older final card and a
  newer segment without a page; prove invalidation updates neither rather than
  falling back. Also prove the newest eligible current/final page is reopened
  and Worker/stale fences are rejected.
- **Pagination (SCN-4, INV-2, ARCH-4):** force activity-bearing overflow and
  assert the frozen card and saved cursor come from the same activity-free
  plan. Cover the edge where that plan consumes all remaining timeline content
  and the continuation contains live activity without duplicated or skipped
  timeline data. Re-run convergence to prove reservation idempotency.
- **Human Review (SCN-5, INV-5, ARCH-5):** prove valid choices render question,
  buttons, then mention; missing/invalid/unpersisted choices render none of the
  three when there is no independent final mention request; no fallback buttons
  are fabricated. Preserve exact owner/generation, final-card ACK, callback,
  and duplicate-action fencing tests.
- **Recovery (SCN-6, INV-6):** prove restart convergence retains a pending
  visible refresh, does not patch frozen/history/late-repair pages, and leaves
  terminal segment state unchanged.
- **Final requester mention (SCN-7, INV-7, INV-8, ARCH-6 through ARCH-8):**
  prove the exact outside-code token is removed from final Markdown, resolves
  only through the trusted current requester, renders one native mention row
  mention, and releases one ACK-gated native notification. Prove repeated
  tokens/replay/restart/replacement are idempotent; inline/fenced code,
  commentary, unknown aliases, raw IDs, stale owners, and missing requesters
  cannot notify. Prove Human Review plus final mention produces one action block
  and one Human Review notification.
- **Timeline/activity separation (SCN-8, INV-9, ARCH-10):** prove Command,
  Read/Edit/Search/Wait, generic Tool, and collaboration/Agent tool calls and
  results remain in the Answer Timeline with stable identities and terminal
  updates. Prove `agent_activity` produces no timeline delta while its same
  canonical event still updates the latest Subagent state (including model)
  through Session Activity. Preserve `update_plan` as Task List-only.
- Record dependency/import/type/assembly evidence separately with
  `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
- Run focused renderer, workflow, Conversation Segment, and Session Activity
  tests first, followed by `git diff --check` and the full Vitest suite.

## Out of Scope

- Core protocol changes or new token/context events.
- Showing tools, model, duplicated goal/task projection, turn, or token usage in
  the Answer Card activity presentation.
- A second Session Activity projection or copying it into the Conversation
  Segment read model.
- Worker Answer/Turn Card redesign.
- Updating, recreating, or backfilling frozen or historical Answer pages.
- PreparedDelivery atomic-view redesign, event/delivery ring redesign, lane,
  outbox recovery, quarantine, or bounded-degradation changes.
- Generic fallback Human Review actions when no valid completion choice exists.
- General-purpose Agent-controlled mention parsing, arbitrary user aliases, or
  notification from commentary/non-final content.
- Production SQLite mutation, install, restart, real Feishu smoke, push, pull
  request, or deployment.

## Further Notes

The first reopened Gate 1 approved design A: deepen the existing projection and
planning interfaces without introducing a new delivery aggregate or local
condition-only patches. The second reopened Gate 1 approved the bounded
`@_user_1` final-requester mention design with trusted identity resolution,
ACK-gated idempotent notification, and coalescing with Human Review. The third
reopened Gate 1 approved replacing the visible `Session Activity` block with a
Task List-style `Subagents` section directly below Task List and excluding all
tool activity. Its final clarification retained the existing Goal, retained
Compaction below Subagents, and placed Human Review/mention immediately after
the Answer Timeline. The fourth reopened Gate 1 separated durable tool history
from latest Subagent state: every canonical tool call remains in Answer
Timeline, while `agent_activity` is rendered only through `Subagents`.

Workspace mode is in-place because this is serial planning and the task-owned
specification path is separable from existing user changes. Workspace:
`<repo>`; branch: `main`; starting
revision: `4bafce330f4463573d3af717c1f7349e737100c5`.

Pre-existing user-owned state is preserved and excluded from task commits:
modified `AGENTS.md`; untracked `.tmp-build/`,
`docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md`.

Fresh pre-specification baseline on 2026-10-09:

- `npx vitest run tests/turn-card-workflow.test.ts tests/turn-card.test.ts tests/conversation-segment-store.test.ts tests/session-activity-store.test.ts`
  — 4 files, 90 tests passed;
- `npm run typecheck` — passed;
- `npm run build` — passed.

Gate 2 approval authorizes implementation-ticket preparation only. It does not
authorize product-code changes, installation, restart, production data
mutation, push, pull-request creation, or deployment.
