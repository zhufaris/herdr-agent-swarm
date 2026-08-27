# Natural Lark Group Interactions Design

**Date:** 2026-08-27

**Status:** Approved for planning

## Summary

Herdr Lark Bridge should feel like a conversational group assistant without
making ambiguous guesses about workflow control. The project Main Card becomes
a state-driven, lightweight action surface. Ordinary topic replies remain FIFO
turns, while an explicit modal provides immediate steering into the active
turn. Less common and higher-impact controls live in an operator-scoped
temporary card instead of permanently filling the shared Main Card.

The design preserves the existing authorities and safety properties: Herdr owns
live pane and agent state, SQLite owns durable workflow intent and idempotency,
Lark is only the visible interaction surface, and high-risk TraeX approval stays
local to Herdr. Existing `/swarm` commands remain supported.

## Goals

- Make creating, following, and controlling a task understandable without
  memorizing the full `/swarm` command set.
- Keep the Main Card compact by showing only actions relevant to its current
  state.
- Make the distinction between a queued follow-up and immediate steering
  explicit at the point of action.
- Support group collaboration while reserving high-impact operations for the
  task creator.
- Make every card action stale-safe, idempotent, auditable, and recoverable
  across bridge restarts.
- Reuse the existing domain workflows so command and card behavior cannot
  diverge.

## Non-goals

- Inferring stop, reset, archive, or steering intent from natural-language
  messages.
- Remote approval or rejection of high-risk TraeX actions.
- Remote process killing or broadening the existing Pane close policy.
- Replacing or removing the complete `/swarm` command surface.
- Making a Lark card authoritative for workflow state.
- Allowing another group member or administrator to take over creator-only
  controls.

## Interaction model

```text
group root
  -> @Bot plus natural language, or /swarm new
  -> explicit project selection
  -> project topic and Main Card
       -> ordinary reply: next FIFO turn
       -> Immediate supplement: steering for the identified active turn
       -> More actions: operator-scoped temporary action card
```

Creating a task always requires an explicit project selection, even when a
default or recently used project exists. Recent projects may be placed first,
but the user must click to confirm the route. This preserves the project
registry as a visible security boundary. While provisioning runs, the selection
card changes to a processing state and rejects duplicate selection.

Ordinary messages in an active topic retain the existing FIFO behavior in every
agent state. The bridge never auto-promotes a reply to steering. When a turn is
active, a queued Answer Card may offer **Move to current turn**. The action is
bound to the turn that was active when the control was rendered. If that turn
has ended, the conversion is rejected and the prompt remains unchanged at its
original queue position. It is never injected into a newer turn.

## State-driven Main Card

The Main Card continues to render the durable `TopicViewState`. Its action area
is a projection of the current state, not an authorization or workflow source.

| State | Primary action | Secondary action or guidance |
| --- | --- | --- |
| Provisioning | None | Brief creation status |
| Idle or done | Send new task | More actions |
| Working | Immediate supplement | More actions |
| Working with queued prompts | Immediate supplement | View queue, More actions |
| Blocked for approval | Immediate supplement | Explain that approval must happen in Herdr; More actions |
| Error or orphaned | View recovery guidance | More actions |
| Archived | Create new task | View historical status |

The shared Main Card does not expose a permanent grid of model, rename, reset,
archive, and Pane controls. The small action set changes with the current state.
Because a shared CardKit card cannot reliably hide elements per viewer, **More
actions** creates a new operator-scoped temporary action card based on freshly
loaded state.

## Immediate supplement modal

Selecting **Immediate supplement** opens a modal containing:

- the current task title;
- a multiline input for the additional instruction;
- a short explanation that ordinary replies queue while this input joins the
  current turn;
- Cancel and Send actions.

The modal submission carries opaque references for `interactionId`,
`bindingId`, `generation`, and `parentPromptId`. It never embeds prompt content,
credentials, or an authorization decision in those references. On submission,
the server reloads durable state and verifies that the binding remains active,
the generation matches, the parent prompt is still the bridge-supervised active
turn, and its state is `working` or `blocked`. A stale modal is rejected with a
short instruction to reopen the action; it never falls back to FIFO and never
targets a replacement turn.

Successful submission follows the existing durable steering path and responds
with a Toast such as `已加入当前执行`. The Answer Card and Main Card converge
through their normal projections and outbox delivery.

## Queued prompt conversion

A queued Answer Card may show **Move to current turn** only while a specific
active turn is eligible. Converting it is one atomic SQLite transition that:

1. verifies the source prompt is still queued and has not started;
2. verifies the recorded parent prompt is still the supervised active turn;
3. changes the queued prompt into steering for that parent without creating a
   second prompt or changing its text;
4. consumes the interaction; and
5. wakes the existing steering execution path after commit.

If any precondition fails, no prompt fields change and its FIFO position is
preserved. A duplicate callback returns the recorded result and cannot inject
the content twice.

## Collaboration and authorization

The binding records the task creator from the actor who completed task
creation. Authorization is always checked server-side against that durable
identity. Card visibility is only a usability aid.

All allowed group members may:

- send ordinary FIFO requests;
- view status and recovery guidance;
- open and submit an Immediate supplement for the current turn; and
- convert their visible queued request into steering when its captured parent
  turn is still active.

Only the task creator may:

- stop the active turn;
- reset the session;
- rename the task and Pane;
- archive the binding; and
- initiate or confirm Pane closure.

There is no takeover flow. A non-creator who requests More actions receives a
read-only/operator-appropriate temporary card. Every callback repeats actor,
binding, generation, action, and current-state validation. Existing Pane-close
confirmation and fresh Herdr identity checks remain mandatory.

## More actions card

The temporary card is generated from the latest state for the requesting
operator. Its sections may include:

- status and queue inspection;
- model selection when the existing model workflow allows it;
- rename, stop, reset, and archive for the creator;
- Pane closure through the existing two-step confirmation; and
- reattach, replace, or resume guidance when the binding lifecycle permits it.

Unavailable actions are omitted rather than shown as a large disabled control
surface. Clicking an old action still produces a safe stale-state response
because omission is not authorization.

## Component boundaries

### Card renderers

Pure renderers in `src/cards/` derive controls from supplied view and capability
data. They render the Main Card action area, project selector, queued-prompt
action, modal, and operator action card. They do not load state or perform
authorization.

### Lark adapter

The adapter normalizes CardKit button callbacks, modal opens, modal submissions,
and Toast responses. It validates external payload shapes with Zod and passes a
typed request containing the authoritative Lark operator identity to the
application layer. It does not mutate prompts or bindings.

### Interaction workflow

A focused interaction workflow is the sole application entry point for card
interactions. It reloads current facts, authorizes the operator, validates and
claims the interaction, then delegates to existing prompt, Pane control, model,
provisioning, session administration, delivery recovery, and Pane closure
workflows. Command handling and card handling therefore share domain behavior.

The existing `InboundRouter` only routes normalized actions to this workflow; it
does not accumulate per-action authorization and stale-state branches.

### Existing workflows and projections

Existing workflows retain ownership of external side effects and durable
business transitions. Successful operations publish or persist the same
lifecycle facts used today. Card refreshes remain projections delivered by the
SQLite outbox. A failed Toast or card update may be retried without repeating a
TraeX prompt or Pane control.

## Durable interaction records

SQLite stores one bounded record per actionable modal or temporary control:

```text
interaction_id
binding_id
generation
actor_open_id
action_kind
parent_prompt_id nullable
target_prompt_id nullable
state: active | claimed | consumed | expired
expires_at
created_at
claimed_at nullable
consumed_at nullable
result_code nullable
```

The record provides restart-safe expiry, actor scoping, replay protection, and
an idempotent result for duplicate Lark callbacks. Records contain no prompt
body. Expired records are retained only for the bounded operational retention
period chosen during implementation and then pruned. Actions also write the
existing audit log without prompt text.

For SQLite-only changes, validation and consumption occur in the same
transaction as the business mutation. For an operation with an external Herdr
side effect, the workflow atomically claims the interaction before attempting
the side effect and records the resulting known or uncertain outcome afterward.
An interruption after the side effect may produce an uncertain result that is
reconciled from Herdr; it must never cause automatic replay.

## Feedback and errors

Successful actions use a concise Toast and refresh existing cards through the
normal projection path. They do not create a new result card. Example messages
include `已加入当前执行`, `已发送停止请求`, `名称已更新`, and
`已切换模型`.

A new card is sent only when the user must inspect or continue an exceptional
flow, including local approval guidance, orphan recovery, Pane-close
confirmation, or dead-letter recovery.

Failures fall into three user-facing classes:

- **Stale state:** explain that the task changed and ask the user to reopen the
  control. Existing queue and turn state remain unchanged.
- **Not authorized:** explain that the action is creator-only without exposing
  additional task or operator data.
- **Uncertain external result:** say that the result is being confirmed and let
  Herdr reconciliation converge it. Never replay the action automatically.

## Help and command compatibility

All current `/swarm` commands retain their parsing and behavior. The default
help card becomes progressive: it leads with natural-language task creation and
the small emergency set (`new`, `status`, `stop`, and `help`), explains FIFO
versus Immediate supplement, and places the complete command reference under an
advanced/recovery section. Operational documentation continues to list the full
surface.

## Delivery phases

### Phase 1: frequent interaction loop

- State-driven Main Card actions.
- Immediate supplement modal.
- Atomic queued-prompt conversion.
- Operator-scoped More actions card with creator authorization.
- Toast plus in-place refresh feedback.
- Progressive help while preserving command compatibility.

### Phase 2: complete session controls

- Route status, model, rename, stop, reset, archive, and Pane close through the
  action card into their existing workflows.
- Add lifecycle-appropriate orphan recovery actions.

### Phase 3: measured polish

- Sort project choices by recent use while preserving explicit confirmation.
- Refine queue position, interaction expiry, and recovery copy from observed
  usage.
- Add action outcome metrics that never include prompt text.

This implementation and deployment delivers phases 1 and 2. Phase 3 remains
post-deployment, data-driven polish and is explicitly outside the completion
gate for this release.

## Testing and acceptance

The implementation is accepted only when the following behaviors have direct
test evidence:

- Each Main Card state renders only its relevant shared actions.
- Project selection always requires an explicit click and duplicate selection
  remains idempotent.
- Ordinary topic replies remain FIFO in `working`, `blocked`, `idle`, `done`,
  and `unknown` states.
- Immediate supplement validates its captured generation and parent turn.
- Queued-to-steering conversion is atomic, does not duplicate or lose text, and
  preserves FIFO position when rejected.
- A turn ending concurrently with modal submission or queue conversion cannot
  redirect content into a newer turn.
- Non-creators cannot stop, reset, rename, archive, or close a Pane through a
  forged or forwarded callback.
- Duplicate callbacks and service restart cannot repeat a steering prompt or
  external Pane action.
- Toast or card delivery failure cannot repeat a successful business action.
- Existing `/swarm` commands, outbox idempotency, detached recovery, and local
  approval boundaries continue to work.
- External callback and modal payloads are schema-validated and prompt content
  remains covered by existing redaction rules.

Verification includes the closest focused Vitest files, `npm run typecheck`,
`npm run build`, and the full `npm test` suite because the change crosses Lark
input, persistence, workflow, and projection boundaries. Deployment uses the
Herdr plugin restart action after a successful build, followed by plugin status
and loopback readiness verification.
