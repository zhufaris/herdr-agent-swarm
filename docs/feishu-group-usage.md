# Feishu Group Usage

This guide describes the current standalone Herdr Agent Swarm behavior in one configured Feishu/Lark group.

## Mental model

A Primary Thread is attached to one exact Herdr Pane generation. Ordinary human text is submitted independently through Herdr Core Agent Input. Swarm does not own an ordinary message FIFO and does not decide final conversation order.

The final order shown in conversation projection comes only from the exact Agent session's Core JSONL. Feishu arrival, local timestamps, SQLite insertion order, message IDs, hashes, and submission receipts are not ordering evidence.

An older input that is running, detached, recovering, or uncertain does not block a newer input.

## Start a Primary session

Mention the bot in the configured group and describe the task. If no route is bound, select a project and optionally an Agent kind:

```text
/swarm new [title] [--agent traex|pi|codex|claude-code]
```

Omitting `--agent` selects TraeX. Provisioning creates or discovers the Herdr Pane, proves its terminal and Agent session identity, then sends initial text through the same Agent Input path as later messages.

If Core does not advertise the required versioned submission capability, the service fails closed before accepting new-path input. It never falls back to untracked terminal text.

## Send Agent input

In a bound conversation context, only the documented `/swarm ...` commands and
authenticated card actions use control grammar. Ordinary text, bot mentions,
Agent-native slash text such as `/model` or `/compact`, and unknown slash text
are not `/swarm` commands. Their treatment is determined only by durable
admission and receipt records; a message-routing acknowledgement is not an
interaction surface or a statement of conversation authority.

Each source message has independent durable admission and effect certainty. A duplicate Feishu delivery converges on the existing Submission Intent. A timeout after the Core attempt becomes uncertain and is queried later; it is not automatically sent again.

Before canonical evidence, the original Feishu message is the only visible
receipt; Swarm does not create a speculative `pending` card. The first unified
Turn Card is created in `working` state only after Swarm ingests the matching
canonical Core JSONL `human_message.submission_id`. It is page zero of that
canonical Human Message's Conversation Segment, and all later content belongs
to the same Core-ordered segment. Direct-Herdr Human Messages use the same rule.

Primary, Worker, and exact-turn steering inputs use the same lifecycle and
status fields. `working` means canonical Human evidence was observed;
`completed`, `failed`, and `cancelled` are terminal; `needs_human` is retained
for historical recovery rows whose ownership or delivery could not be proven.
Content beyond the 9,000-character CardKit limit continues in a new page of the
same segment. Frozen pages are never patched.

## Explicit Swarm commands

These commands are reserved for Swarm control:

```text
/swarm help
/swarm projects
/swarm spaces
/swarm panes
/swarm sessions [cursor]
/swarm failures
/swarm status
/swarm new [title] [--agent traex|pi|codex|claude-code]
/swarm reset [description]
/swarm attach <pane-token>
/swarm attach <space> <pane>
/swarm rename <title>
/swarm model [name]
/swarm steer <instruction>
/swarm stop
/swarm reattach <pane>
/swarm replace
/swarm resume
/swarm awake
/swarm worker create <name> [--agent <kind>] [--model <name>] [--start]
/swarm close
/swarm close confirm <code>
```

`/swarm skip` is retired. Sending it returns help and does not modify historical evidence or release later work.

### `/swarm status`

Refreshes the current Primary Main Card from Binding and Core-derived projection state. Operator service status reports Submission Intent receipt states, Core projection lag/gaps, outbox work, recovery stages, and bounded Delivery checkpoint evidence (scope count, oldest blocker, uncertain/quarantine blocker counts). `/status` also reports grace-blocked scopes, isolated conflicts and uncertainty, completed bypasses, pending Delivery Human Review, and oldest review age. These counters contain no card payload. It does not report an ordinary Prompt FIFO as current execution state.

### `/swarm steer <instruction>`

If Herdr proves an exact active Turn, the instruction is injected as exact-turn steering. If there is no exact active Turn, the instruction becomes an independent Agent Input. A local legacy busy/detached state does not block it.

The visible success means the control was accepted under current identity fences. It does not impose a local order on future Core JSONL events.

### `/swarm stop`

Re-observes Herdr and interrupts only the exact active Turn. It does not stop or kill the Pane and does not cancel unrelated Agent Input. If identity changes before the effect, the operation fails closed.

High-risk approval or denial remains local to the Herdr Pane.

### `/swarm awake`

Runs Core projection catch-up, checks recovery gaps, and schedules durable Main/Answer Card redelivery. It never wakes a Prompt dispatcher and never submits Agent Input.

Use it when Core has progressed but Feishu cards appear stale. A successful response means recovery/redelivery was durably scheduled or converged; CardKit acknowledgement can still arrive later.

### `/swarm resume`

Reactivates an archived Binding only when its retained Pane identity can still be proven. It has no Prompt-queue or detached-blocker meaning.

### `/swarm reset`, `reattach`, and `replace`

- `reset` creates a fresh managed Pane/session for the current Thread.
- `reattach` binds an orphaned session to a proven existing Pane.
- `replace` creates a replacement Pane for an orphaned session.

All three use Binding generation and runtime identity fences. They do not infer state from old cards.

### `/swarm close`

Returns a short-lived confirmation code. Confirmation rechecks the Primary and owned Worker Panes before closing any safe target. Busy, missing, or identity-uncertain Panes are retained and reported. Lark history and Worker worktrees remain.

## CardKit actions

Card actions carry immutable Binding/Worker generation context. A stale card cannot operate a replacement session.

Historical Primary completion or continuation actions no longer create a Prompt. The card tells the user to send a current Thread message so the text follows the Agent Input path. Ignore/dismiss actions that affect only local presentation remain local.

Frozen Answer pages are never patched. If exact recovery finds late terminal output, Swarm creates a continuation delivery and advances the replaceable Main Card.

Subagent activity stays inside the owning Answer or Turn Card. When Core can
provide a plaintext lifecycle result, the activity row shows its latest
redacted, bounded content beneath the Subagent status and model. A later
status-only update retains that content. Activity arriving after a page freezes
is rendered through the active continuation page; Swarm does not create one
standalone card per Subagent update. Encrypted inter-agent transcript content is
not decoded by this feature.

### Trace-end Completion Review

For an eligible Swarm-managed TraeX trace, the installed `herdr-choice-list`
`UserPromptSubmit` Hook asks the Agent to include any Human Review choice in
its original final answer. The legacy Stop Hook validates only the explicit
terminal protocol, not prose intent. On the first Stop for an eligible turn,
missing or invalid metadata may block once and request a protocol-only repair
for that same turn; a repeated Stop with `stop_hook_active` fails open. If the
final protocol says review is not useful, or repair still leaves it missing or
invalid, the Answer closes without extra controls. If review is useful, Swarm
creates one new Completion Review card. Its initial card includes the responsible
user's native mention, the Agent-declared question, one to four ordered action
buttons, and **Ignore**.
The frozen Answer or Worker Task Card is not changed, and Swarm sends no
separate reminder or mention message. Core removes the internal protocol block
before emitting canonical `completion_choice`. Independently, before Feishu
presentation, Swarm removes every reserved `herdr-choice-list` region from the
visible answer whether the region is valid, malformed, duplicated, incomplete,
oversized, or nonterminal, and whether or not controls activate. Surrounding
answer prose remains visible.

Clicking a business choice uses the persisted server-side choice to submit an
ordinary next Agent Input; clicking Ignore only dismisses the local suggestion
and does not start a Prompt or Worker Turn. Repeated, stale, wrong-user, or
wrong-generation callbacks cannot create duplicate work. Delivery is recorded
before Lark is called. After a restart, only an exact linked delivered receipt
with a message identity activates the same review; pending and uncertain
presentations remain `presenting` for delivery or operator recovery and are
never automatically replaced. Status reports bounded review lifecycle counts,
not review content.

There is no planned native completion-envelope cutover. The supported path is
the existing `UserPromptSubmit` writer Hook plus bounded one-repair Stop Hook;
Core strips the terminal fence, emits canonical `completion_choice`, and
Swarm/Feishu consume that projection. The writer Hook is not scheduled for
removal.

A review for a canonical Worker Thread segment names the Worker and submits a
business choice to that Worker Thread; it remains fenced by the active Worker
session and its parent Binding/Pane. It is delivered through the Worker's own
Pane Ring, which does not make the Worker Thread a child conversation.

This feature is named `herdr-choice-list`; `herdr-button-list` was an early TODO
name and is not a separate installed Skill. High-risk native approval and
denial still remain local to the Herdr Pane.

## Workers

Create a Worker from a Primary Thread:

```text
/swarm worker create reviewer --start
/swarm worker create reviewer --agent codex --start
```

Worker identity is fenced by Worker generation, Worker-session generation,
owning Primary generation, and parent Pane. A Worker Pane has its own named
Worker Thread and the same Completion Review lifecycle as a Primary Thread. Its
parent Primary contributes binding and generation fences plus the parent Primary
Pane fence; it does not own the Worker Thread/name or delivery order. Each
actual Worker Pane has a separate Worker Delivery Ring. Historical deliveries
already frozen on a parent Pane keep that legacy Ring until they settle.

The group-level convenience commands remain:

```text
/projects
/project <id>
/instances
/instance <worker-name>
/to <worker-name> <task>
/steer <worker-name> <instruction>
/stop <worker-name>
```

`/to` creates independent Worker Agent Input. `/steer` and `/stop` are exact Worker controls and fail closed on stale ownership.

## Model selection

`/swarm model` lists or selects a model for the current supported Agent route. Model control remains separately fenced from ordinary input. A model result marked uncertain is never automatically replayed.

Unsupported model, transcript, steering, or stop capabilities fail closed instead of falling back to TraeX or arbitrary terminal input.

## Fixed Orchestrator Thread

An optional configured project can keep one managed TraeX Pane labeled `herdr`, native token `orch`, and one 固定 Orchestrator Thread. It is intended for long-lived group coordination.

`/swarm clear` is available only there. After confirmation it rotates the native Agent session, increments the durable epoch, withdraws earlier Answer cards, and preserves the fixed identity surface: Pane ID、token、名称、位置、Binding、Thread 和 Workers. If cleanup is incomplete, the result is reported as `partial`; the service does not claim a full clear.

The fixed Orchestrator Thread does not weaken Agent Input ordering or identity rules.

## What cards mean

- Main Card: current Binding/runtime and latest Core-derived projection.
- Answer Card/Page: delivery projection of one Core Turn timeline.
- Worker Main/Task Card: Worker identity and Core-derived task view.
- Command Status Card: durable control admission/execution result.

Cards are not execution authority. A stale or missing card does not mean Core stopped, and a visible card cannot repair SQLite.

## Delivery and recovery

Projection changes reserve delivery intent in SQLite. The outbox sends CardKit work by delivery lane with idempotency and retry. A failed delivery retries only the card effect.

Useful operator distinctions:

| Signal | Meaning |
| --- | --- |
| Submission Intent `recorded` | Eligible for its own Core submission. |
| `attempting` or `uncertain` | May have crossed the effect boundary; query receipt, do not resend. |
| Core projection pending/quarantined | Canonical events are not fully projected yet. |
| Projection gap `not_found` or `ambiguous` | Exact recovery needs more Core evidence or human review. |
| Projection gap `cursor_epoch_changed` | An identity-stable Core ring/session/Agent lane moved to a new epoch; SQLite atomically recorded the boundary and restarted that lane at the live epoch `start`. |
| Outbox `pending` | Delivery is actionable. |
| `waitingBehindLane` | A prior CardKit effect in the same lane must finish first. |
| Dead letter | Delivery exhausted retry and needs operator action. |
| Grace blocked | The unresolved Delivery still blocks its whole Pane or Global Ring within its bounded recovery budget. |
| Conflict isolated | Independent conflict keys may bypass the failed Delivery; same-key work and explicit dependents still wait. The original quarantine is not released. |
| Pending Delivery Human Review | A durable independent review card exists or awaits delivery. It mentions the responsible actor when known and never exposes the Delivery payload. |
| Completion Review `presenting` | A fresh review card has a durable outbox link but has not yet been activated by an exact delivered receipt. |
| Completion Review `active` | The exact delivered receipt and message identity activated the existing review; its frozen payload and live outbox link are retained. |

Conflict isolation is bounded degradation, not data loss. The original failed
Delivery and certainty evidence remain queryable, and the durable Ring
checkpoint stays before the unresolved order. Only confirmed `not-started` or
`rejected` work with stable identity and safe reconstruction may create one
replacement; this can yield at most one visible duplicate. An `uncertain`
effect, frozen page, or message deletion is not replayed, replaced,
dismissed, or directly retried. Prepared Conversation Page deliveries are the
bounded exception: they reuse the same durable delivery and idempotency
identity across the approved three-attempt policy, so a later attempt may
duplicate or overwrite an already-applied uncertain Lark effect. After attempt
3, the delivery is terminally dismissed and its local page link is released so
a newer snapshot can reserve normally. The review card offers Retry only when
the persisted effect kind and evidence satisfy that narrower direct-retry
policy for other paths; otherwise it offers audit-preserving dismissal only.

For v2 Core session ingestion, do not treat every cursor failure alike. A
same-epoch retained-window expiry rebases only from typed `cursor_expired`
evidence carrying Core's `resume_cursor`. An identity-stable epoch transition
requires the same ring/source, session, and Agent identity with a different
epoch proven by ring-open before the read; it atomically records
`cursor_epoch_changed` and installs the live epoch `start` checkpoint before
reading. An identity mismatch or untyped same-epoch `invalid_cursor` fails
closed. One attempt permits at most that one epoch transition plus one typed
same-epoch expiry; it never replays Agent Input or treats a card as Core truth.

## Troubleshooting stale cards

1. Run `/swarm status` in the Thread.
2. Run `/swarm awake` to request projection catch-up and card redelivery.
3. On the host, run `npm run swarm:status` and inspect Submission Intent, Core
   projection, gap, outbox, and recovery sections. In `/status`,
   `coreSessionIngestion` shows the scan count, active and lagging sessions,
   oldest observed lag, retry deadline/attempt, last successful ingest, and
   last typed failure. A required failure while recovering a historical
   Pending-first Input Card makes the Agent Input readiness component
   `not_ready`; current admissions do not create such cards.
   Delivery checkpoint fields identify the scope-local blocker without exposing
   the card payload. Bounded-degradation fields distinguish grace blocking from
   conflict isolation and show pending review age. A nonterminal blocker is not
   released merely because independent work bypassed it or because it is old.
4. Correlate by Binding, submission, session, Turn, or reply ID in `npm run swarm:logs`.
5. Check the actual Herdr Pane before concluding that the Agent is idle or stopped.

For a later authorized epoch-transition rollout, use read-only evidence in
this order: service readiness and `agentInput` readiness are healthy; the
affected session's lag and retry state converge; the exact durable lane
checkpoint moves to the live epoch and cursor; then the Core final projection
advances and the matching card/outbox work progresses. Do not resend text to
force this sequence. Production mutation, installation, restart, and deployment
are separate operations and are not automatic recovery commands.

Do not resend uncertain text merely to unstick the UI. A new human message is a new independent Agent Input; it does not resolve the older receipt or projection gap.

## Authorization and safety

- Only configured-chat, user-originated messages and configured-chat CardKit actions are accepted.
- Allowed-user, creator, and administrator checks still apply per command.
- Project registry routes are a security boundary.
- The bridge cannot remotely approve high-risk Agent requests.
- The bridge cannot send arbitrary terminal input, kill a process, or kill a Pane.
- Source text is redacted from command errors/logs and bounded before persistence/delivery.

For host installation, restart gates, and logs, use the root [README](../README.md). For implementation details, use [Architecture](architecture.md).
