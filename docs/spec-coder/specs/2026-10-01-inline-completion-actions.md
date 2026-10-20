# Inline Completion Actions

## Problem Statement

Successful Primary and Worker conversations currently end with two cards. The
final Answer or Worker Task Card contains the completed result, then a separate
completion-notification card repeats a bounded assistant preview, mentions the
request actor, and reports that the Agent is ready for more input. The two
surfaces look duplicative even though the second card exists to enforce durable
ordering after final-card delivery.

Users should instead see one terminal conversation card. When the conversation
has completed successfully and no later Human Message has been accepted, the
last Answer or Worker Task Card should end with a mention and four one-click
responses. Those responses are ordinary Human Messages; they must not become a
remote approval path for native tools, arbitrary terminal input, process
control, or Pane control.

## Solution

Replace the independently delivered completion-notification card with a
durable **Completion Action Set** rendered inside the final Primary Answer or
Worker Task Card. The terminal projection transaction decides whether the set
is eligible, resolves its mention target, persists its one-shot identity, and
includes it in the same sequenced final CardKit update as the completed answer.

An eligible final card ends with:

`<at ...></at> 已完成，等待你的下一条消息。`

followed by `default`, `批准`, `继续`, and `拒绝` buttons. Their fixed message
mappings are:

| Action | Ordinary Human Message |
| --- | --- |
| `default` | `default` |
| `approve` | `批准，按当前方案继续执行。` |
| `continue` | `继续。` |
| `reject` | `拒绝，请停止当前方案并等待进一步指示。` |

For Primary, a successful action creates an ordinary FIFO Prompt in the same
Binding. For Worker, it creates a FIFO follow-up associated with the completed
Worker Turn. Only the mentioned user may act. The four buttons share one
one-shot eligibility record, and any accepted later Human Message supersedes
that record.

## User Stories

### SCN-1: Primary completes as one interactive Answer Card

When a current-generation Primary Prompt completes successfully, its final
Answer projection is complete, its exact final page is eligible for mutation,
and no later Human Message has been accepted in canonical FIFO order, the final
sequenced CardKit update includes the resolved mention and all four quick
actions. No independent completion-notification card is created.

If a later Human Message is already accepted when terminal projection commits,
the Prompt completes without the mention or quick actions.

### SCN-2: Worker completes under the same interaction contract

When a current Worker Session Turn completes successfully and has no later
accepted Human Message in that Worker Session FIFO, its final Worker Task Card
includes the same mention and four quick actions. The action remains fenced by
the exact Worker, Worker generation, Worker Session generation, parent Binding
generation, completed Turn, and final card message identity.

### SCN-3: Mention identity is safe and explicit

The completed request's valid Feishu human actor is the preferred mention. A
valid current Binding creator is the fallback. Only the resolved mentioned user
may click the quick actions. If neither identity is valid, the final result is
delivered normally without a mention or action set; completion is never blocked
by missing presentation identity.

### SCN-4: A quick action creates exactly one ordinary follow-up

When the mentioned user clicks one of the four actions while its Completion
Action Set is available, Swarm atomically consumes the set and accepts exactly
one mapped Human Message. Primary creates a same-Binding ordinary FIFO Prompt;
Worker creates a same-Worker-Session FIFO follow-up related to the completed
Turn. Retried callbacks return the already-decided result and do not create
another Prompt or Turn.

The `批准` action does not approve any native tool or high-risk operation. It
only submits its fixed text through ordinary conversation admission.

### SCN-5: Later Human input wins the same one-shot race

When a normal Human Message and a quick action race, SQLite commit order decides
the winner. Accepting a later ordinary Human Message first marks the prior
Completion Action Set superseded; the button callback is then rejected as
stale. Consuming a quick action first accepts its mapped Human Message; a later
ordinary message remains a distinct, normally ordered request.

Two simultaneous button clicks have the same rule: at most one consumes the
set and creates work. Every losing or stale click receives a bounded warning
and causes no workflow mutation.

### SCN-6: The final card converges after consumption or supersession

After a Completion Action Set is consumed or superseded, Swarm reserves a newer
sequenced update for the same final card. The update removes all four buttons
and records the selected action when one was consumed. If the cleanup update is
delayed or fails, a stale visible button still cannot create work because the
durable action state is authoritative.

### SCN-7: Failure and recovery do not duplicate Agent work

Delivery retry, provider uncertainty, process restart, duplicate callbacks,
and startup convergence never repeat a Prompt or Worker Turn. Startup uses the
same persisted action-set decision and final-card projection rules as live
convergence. Failed, cancelled, aborted, interrupted, uncertain, blocked, and
Human Review outcomes do not create a Completion Action Set.

## Implementation Decisions

### Domain Model

The affected bounded contexts are **Prompt Execution**, **Worker Runtime**,
**Conversation Projection**, and **Delivery and Operations**.

| Context | Responsibility |
| --- | --- |
| Prompt Execution | Own ordinary Primary Prompt admission, canonical FIFO ordering, Prompt source identity, and no-replay behavior. |
| Worker Runtime | Own Worker follow-up admission and exact Worker, session-generation, parent-Binding, and Turn ownership. |
| Conversation Projection | Own the final Answer/Task Card and the visible lifecycle of its Completion Action Set. |
| Delivery and Operations | Own immutable sequenced delivery intents, CardKit lane ordering, checkpointing, retry, and recovery. |

A **Completion Action Set** is proposed durable Conversation Projection state
for one exact successful Primary Prompt or Worker Turn. It is not an approval
grant and does not own execution. Its business identity includes owner kind,
owner ID, owner generation, and the final card identity. It stores the resolved
mention user and transitions through `available`, `consumed`, `superseded`, or
`unavailable`. A consumed set records the selected value from the closed set
`default | approve | continue | reject` and the resulting Prompt or Turn source
identity. A superseded or unavailable set cannot be reopened.

The existing completion-notification obligation is the migration source for
this concept. Its responsibility changes from authorizing a separate outbound
card to controlling the terminal interaction region of the owning final card.
No new cross-context aggregate is introduced. The authoritative write remains
the SQLite transaction that owns the related projection and admission changes.

#### Invariants

- **INV-1 — Exact terminal eligibility:** only a successful, current-owner,
  current-generation completion whose final page can receive the terminal
  projection may create an available Completion Action Set.
- **INV-2 — No later Human Message:** an accepted later Human Message in the
  same Primary Binding or Worker Session FIFO prevents availability or
  supersedes an existing available set.
- **INV-3 — Exact actor authority:** only the persisted mentioned Feishu Open ID
  may consume the set. The completed request actor is preferred and the current
  Binding creator is the fallback.
- **INV-4 — One set, one decision:** the four buttons share one conditional
  state transition; at most one action can consume it.
- **INV-5 — Atomic follow-up admission:** consuming an action and accepting its
  mapped Prompt or Worker follow-up commit together. A crash cannot consume the
  action without durable work or create durable work while leaving the action
  available.
- **INV-6 — Stable idempotency:** an action callback has a stable source
  identity derived from the action-set identity and selected action. Duplicate
  delivery or callback retry returns the existing admission result.
- **INV-7 — Presentation is not authority:** stale or delayed CardKit content
  cannot override the persisted action state or ownership fences.
- **INV-8 — No remote native approval:** `approve` is translated only to its
  fixed ordinary Human Message. It cannot create an ApprovalGrant, submit
  terminal input, approve a native tool, or invoke process/Pane controls.
- **INV-9 — Frozen history remains immutable:** only the exact final page for
  the completed owner receives action-set convergence. Earlier frozen Answer or
  Worker Task pages are never patched.
- **INV-10 — No execution replay:** creation, migration, cleanup, retry, and
  startup convergence never resubmit an existing Prompt or Worker Turn.

### Architecture

A pure Completion Action Set policy receives normalized evidence: terminal
outcome, owner and generation identity, final-page eligibility, later-Human
work evidence, request actor, Binding creator, and current routing. It returns
`available` with a resolved mention or `unavailable/superseded` with a stable
reason. It imports neither SQLite nor CardKit types.

The SQLite completion capability owns persistence and conditional transitions.
It exposes a small consumer-oriented interface for:

- deciding and persisting terminal availability while reserving the final-card
  projection;
- atomically superseding an available set during ordinary Human admission;
- atomically consuming an exact action and admitting its mapped follow-up;
- loading render state for final-card convergence and startup recovery.

Primary and Worker admission use the same action-set state machine but retain
their existing execution-specific acceptance paths. The Primary adapter creates
an ordinary Prompt with the existing Binding FIFO and source-identity rules.
The Worker adapter creates a `followup` Turn through the existing Worker
messaging contract. No shared mutable execution entity crosses contexts.

The card-action parser gains one closed quick-action command carrying only the
action-set ID, selected action, exact owner/generation context, and final card
message identity. The router applies the existing configured-chat and
allowed-user gate before the application workflow performs mentioned-user and
ownership validation. Feishu payloads are translated at the existing adapter
boundary; domain policy sees normalized identifiers and the closed action enum.

Primary and Worker final-card renderers receive an optional internal Completion
Action Set render DTO. They append one mention line and a single four-button row
after existing Answer/Task content. The DTO never contains an SDK object. The
render-only footer does not change canonical Agent output, timeline items, or
source offsets.

The final Answer/Task projection transaction allocates the next CardKit sequence
and reserves one immutable full-card Delivery Intent containing the interaction
region. Consumption or supersession increments the projection through the same
page lane and reserves a later sequence that removes the buttons. Delivery
checkpointing never makes eligibility decisions.

Source dependencies continue to point inward:

```text
Lark adapter -> card-action router -> completion-action workflow
                                      -> consumer-owned store interfaces
SQLite adapters --------------------------^
CardKit renderers -> normalized render DTOs -> domain action state
composition root -> concrete stores + workflows + renderers
```

### Behavior & Failure Modes

Terminal availability, later-message supersession, and button consumption use
conditional writes from the expected current state. SQLite transaction order is
the conflict mechanism. The losing operation observes the new state and returns
a deterministic stale/already-decided outcome.

Ordinary Primary acceptance compares canonical `(created_at, rowid)` FIFO order
within the Binding generation. Worker acceptance uses the exact Worker Session
generation and accepted Turn ordering. Neither path infers ownership from text,
timestamps alone, card content, or nearest-neighbor records.

When a quick action succeeds, its source identity is independent of the Lark
callback delivery attempt. The resulting Prompt or Turn uses the same actor as
the validated clicker and retains a parent relation to the completed owner where
the existing execution model supports it. The action response reports success
and queue position using the existing interaction-toast pattern.

CardKit and SQLite cannot commit atomically. If an interaction-bearing update
is externally visible before its local checkpoint, its persisted action set is
already available and safe to consume. If a later message supersedes the set
while an older card update is in flight, lane ordering eventually delivers the
newer button-removal snapshot. Any transiently stale visible button fails closed
at callback admission.

A failed final-card delivery follows existing retry and quarantine behavior. It
does not create a separate notification card. A failed cleanup update leaves the
workflow state correct and the UI stale; normal outbox recovery retries or
rebuilds the current final-card snapshot. Startup convergence reads the durable
set and current projection, never Lark card content.

If the last page has insufficient payload capacity, the existing deterministic
pagination reserves space for the terminal interaction region and moves answer
content to the next Answer/Task page as needed. The resulting last card still
contains canonical answer content plus the interaction region; no
mention-only card is created. Frozen prior pages remain unchanged.

### Compatibility & Migration

The schema migration is additive or a foreign-key-safe rebuild of the existing
completion obligation table, preserving owner identity, generation, creation
time, and audit evidence. Existing completed Prompt and Turn rows are not
backfilled into new available action sets, preventing a rollout notification
storm.

Already delivered standalone completion-notification cards remain immutable
external history. New code no longer creates `primary-next-input:*` or
`worker-next-input:*` standalone card replies.

During migration/startup, an unclaimed pending legacy completion-card intent
may be dismissed only when exact owner/generation and current final-card
evidence permit deterministic inline convergence. Claimed, delivered,
dead-lettered, or delivery-uncertain legacy effects are not rewritten or
assumed absent. Their obligation remains terminal/auditable, preventing a
second visible completion effect.

Existing ordinary message, Worker follow-up, Human Review, native approval,
turn-control, and card-navigation contracts retain their public meanings.

## Testing Decisions

- **Policy unit tests:** cover successful Primary/Worker eligibility, later
  Human work, generation mismatch, non-success terminal states, actor-to-creator
  fallback, missing mention identity, closed action values, and the prohibition
  on mapping `approve` to native approval.
- **Renderer tests:** prove both final-card renderers append exactly one mention
  and the four buttons, omit the former duplicated preview/identity card, stay
  within payload limits, keep action content render-only, and never patch frozen
  earlier pages.
- **SQLite/store integration tests:** prove save/reopen of all action-set states,
  conditional consume/supersede transitions, stable idempotency, and the two
  relevant interleavings: ordinary input versus click and click versus click.
- **Primary workflow tests:** prove each fixed action mapping creates exactly one
  ordinary FIFO Prompt for the same Binding, only the mentioned actor succeeds,
  stale card/generation attempts fail, and normal later input removes eligibility.
- **Worker workflow tests:** prove the equivalent behavior for an exact Worker
  Session follow-up and preserve parent Binding, Worker, session-generation, and
  completed-Turn fences.
- **Delivery/recovery tests:** prove the interaction-bearing snapshot shares the
  final page lane and sequence, cleanup is a newer same-card update, stale UI
  cannot bypass SQLite state, restart converges without replay, and eligible
  pending legacy standalone intents are dismissed without touching uncertain
  effects.
- **Architecture evidence:** extend the import-boundary suite or perform an
  explicit import review proving the pure policy imports neither SQLite nor
  CardKit/Lark adapters, and application coordination depends on consumer-owned
  interfaces.
- **Final verification:** run focused card-action, Primary/Worker workflow,
  answer-page, startup-recovery, and SQLite suites, then `npm run typecheck`,
  `npm run build`, and the complete `npm test` suite.

## Out of Scope

- Deleting or editing already delivered standalone completion cards.
- Remote approval or denial of TraeX tools, shell commands, credentials,
  deployments, destructive operations, process control, or Pane control.
- Free-form button input, configurable action labels/messages, or per-project
  action sets.
- Changing ordinary text-message routing, native steering, Human Review cards,
  Answer content semantics, or the no-replay recovery contract.
- Pushing commits, opening a pull request, installing a release, or restarting
  the live service.

## Further Notes

- Workspace mode: in place at
  `/workspace/herdr-agent-swarm`.
- Reason: tracked files were clean, the specification path was absent, and the
  task does not overlap the protected initial untracked paths.
- Branch: `main`.
- Starting revision: `06de52dd0d647b4967d84a58c4f63e4466a3e704`.
- Protected initial untracked paths: `.tmp-core-build/`,
  `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline on 2026-10-01 UTC:
  - `npm test`: 235 files and 3,270 tests passed.
  - `npm run typecheck`: passed.
  - `npm run build`: passed and generated build identity
    `sha256:324a7a170879363b285e674f5d33aa1c08e4af56ecdf8ba67afdff5d40814c18`.
- The first concurrent baseline attempt overlapped `npm test` with the build
  prepare step and temporarily removed `dist/build-info.json`; the resulting
  seven installer-test failures were invalid environmental interference. The
  required sequential rerun passed completely.
- Gate 1 design was approved after adding the `default` action. Gate 2
  specification was approved by the user's instruction to continue. Gate 3
  ticket approval and implementation authorization are pending.
- Unresolved load-bearing decisions: none.
