# Worker Task-Centered Interaction Design

## Status

Implemented. This document is the behavioral contract for Worker Task Card
replies and the acceptance evidence required when changing that routing.

The intended reader is an engineer maintaining Lark ingress, Worker messaging,
or durable card projection. After reading it, they should be able to modify the
reply path without routing an instruction to the wrong Worker or replaying work.

## Goal

Make a Worker task card the normal place to understand and continue one unit of
work. A user should not need to decide between `/to`, `/steer`, and a card reply
before expressing an instruction. The system derives the only safe meaning from
the exact task state while preserving FIFO order, generation fences, transcript
ownership, and the no-replay rule.

The interaction must answer four questions in place:

1. Which Worker and exact task does this card represent?
2. What is the task doing now?
3. What instruction can the user safely send next?
4. Where will that instruction go?

## Interaction Vocabulary

Worker instructions have three distinct meanings. They must remain distinct in
the durable model even when the card makes choosing one feel automatic.

| User intent | Primary entry | Durable meaning | Scheduling |
| --- | --- | --- | --- |
| Modify the active task | Reply to its running or blocked Task Card | Exact-turn steer | Delivered only to the fenced active turn |
| Continue a finished task | Reply to its completed, failed, or cancelled Task Card | Follow-up with `parentTurnId` | New FIFO task |
| Start unrelated work | Worker Main Card or `/to <worker> <text>` | Independent turn | New FIFO task |

`/steer` remains an explicit expert shortcut for an active turn. `/to` always
means a new independent FIFO task, including when sent as a reply to a Task
Card. Existing command behavior is not overloaded or removed.

## State-Driven Task Card

The Task Card is the daily interaction surface. Its visible action and guidance
are derived from the freshly loaded durable state, not from stale card content.
Every callback and reply remains fenced by Primary binding generation, Worker
generation, Worker session generation, and task identity.

### Queued

- Show queue position and that execution has not started.
- Do not accept a reply as steer or follow-up.
- Explain that the user can wait or create a separate task; cancellation of an
  unstarted task may be added only through a dedicated, transactional workflow.
- Do not expose Stop, Steer, or Retry.

### Preparing

- Explain that dispatch has started but exact runtime-turn ownership is not yet
  established.
- Reject contextual replies instead of guessing whether they are a steer or a
  new FIFO task.
- Once exact ownership is established, project the card as running.

### Running

- Show the current trusted status, plan, recent tool activity, and streamed
  answer already owned by this exact runtime turn.
- Tell the user that replying to this card with `@Bot` supplements the current
  task.
- Route that reply as an exact-turn steer. It must never fall back to a queued
  turn if the turn settles or changes before delivery.
- Show `停止当前任务` only when an exact active turn is still interruptible.

### Blocked

- Explain that approval or local input must be handled in the Herdr pane.
- A reply may still steer the exact blocked turn when the driver supports it,
  but it cannot remotely approve or answer a protected local prompt.
- Keep the pane identity visible so the operator knows where to act.

### Completed, failed, or cancelled

- Freeze the original result pages and terminal outcome.
- Tell the user that replying creates a follow-up task for the same Worker.
- Persist the new turn with the old turn as `parentTurnId`; enqueue it normally
  after existing FIFO work.
- Failure does not imply retry. The follow-up is a new explicit request.

### Dispatch uncertain

- Explain that the request may already have reached the Agent and will not be
  replayed automatically.
- Reject replies, Retry, and Follow-up from this card until the operator has
  inspected the corresponding Herdr pane and durable state.
- Offer only non-mutating refresh/inspection guidance. Recovery remains an
  explicit operator workflow.

## Worker Main Card

Worker Main remains the session-level directory, not a second control center for
the current turn. It shows identity, runtime, current task, FIFO depth, and recent
terminal tasks. Its primary task action is `发起新任务`, which always creates an
independent FIFO turn. Links open the current or recent Task Card.

The card must state whether a new task will run immediately or queue behind the
current task. It does not offer a generic `追加 prompt` button because that phrase
is ambiguous between steer and follow-up. Current-turn actions live on the exact
Task Card.

## Copy and Feedback

Use intent-oriented Chinese labels rather than protocol names where possible:

- `补充当前任务` for exact-turn steer;
- `继续这个任务` for a terminal follow-up;
- `发起新任务` for an independent FIFO turn;
- `停止当前任务` for exact active-turn interruption;
- `前往 Herdr 处理` as blocked-state guidance, not a remote approval action.

Successful submission feedback states both the meaning and destination, for
example `已补充到 reviewer 的当前任务` or `已创建后续任务，当前排队位置 2`。
Rejected actions explain the state transition that invalidated them and do not
silently choose a different semantic.

## Data Flow and Boundaries

No new lifecycle authority is introduced. The existing boundaries remain:

1. Lark reply or callback is normalized by the adapter.
2. For a direct reply, the normalized Lark `parent_id` is the exact replied-card
   message identity. The store resolves that identity across the Task Card's
   main page and continuation pages. Exactly one durable turn must match; zero
   or multiple matches fail closed.
3. `InstanceInteractionWorkflow` obtains the Worker from the resolved turn's
   `instanceId`. The selected conversation target and Worker names do not
   participate in routing. It then reloads the Worker and Primary ownership.
4. Active/blocked replies call exact-turn steering; terminal replies call
   `InstanceMessagingWorkflow.submit` with `kind: followup` and `parentTurnId`.
5. Independent Main Card submissions call the same messaging workflow with
   `kind: turn` and no parent.
6. SQLite persists the turn/card/outbox intent before any Lark delivery.
7. The Worker scheduler dispatches at most one ordinary turn for the Worker; the
   observer projects only exact owned transcript output.

The direct parent message remains the routing authority. The system does not
guess from Thread position, selected Worker, names in prose, or an older ancestor
message. Worker completion never automatically starts a Primary turn.

## Failure Handling

- If state changes between rendering and submission, reload and reject with the
  new state; never reinterpret steer as follow-up or the reverse.
- Duplicate Lark delivery reuses the source-message idempotency key.
- A failed card or Toast delivery retries only presentation, never the Agent
  prompt.
- A generation/session mismatch invalidates the old card.
- An absent or ambiguous card-message mapping is not routed through the currently
  selected Worker; ordinary Primary routing may handle it only after the Worker
  reply path declines it.
- Missing exact transcript ownership cannot produce progress or completion.
- Stop interrupts only the exact active turn and does not cancel FIFO backlog.
- The bridge never exposes remote approval for high-risk TraeX prompts.

## Implemented Scope

1. State-specific guidance and legal actions are present on Worker Task Cards.
2. Worker Main Card provides an independent `发起新任务` form.
3. Direct-reply routing is shared by steer and follow-up; a centralized
   state-to-intent decision keeps card buttons and replies from diverging.
4. Intent-specific success and rejection feedback includes queue position.
5. The Feishu user guide and interaction tests describe the same behavior.
6. The real multi-agent smoke script uses the current Thread Primary
   binding model instead of the removed persistent Primary instance API.

This contract does not include queued-task cancellation, remote approval,
automatic retry, Worker-to-Worker delegation, or automatic Primary wake-up.
Those require separate workflow and authorization designs.

## Test and Acceptance Matrix

### Deterministic interaction tests

- A direct reply to a running or blocked Task Card steers only the exact active
  turn and never enqueues fallback work.
- A direct reply to completed, failed, or cancelled creates one idempotent
  follow-up with the correct `parentTurnId` and FIFO position.
- With multiple Workers present and a different Worker selected, the exact
  replied Task Card still determines the destination Worker.
- Replies to continuation pages resolve to the same task and Worker as the main
  Task Card. Missing or ambiguous message mappings fail closed.
- Replies to queued and dispatch-uncertain tasks are rejected without terminal
  input or new turns.
- `/to` remains an independent turn even when replying to a Task Card.
- Stale binding, Worker generation, session generation, task, and message IDs are
  rejected.
- Task and Main Cards expose only actions legal for their current state and keep
  secrets/reasoning out of rendered content.
- Duplicate callbacks/messages do not duplicate steer, follow-up, card, or
  outbox intent.

### Product-flow integration

- A current Thread Primary lists an existing same-project Worker, submits one
  task through the Primary MCP boundary, observes completion, and summarizes it.
- Worker completion does not create another Primary turn.
- Restart preserves the completed Worker task and rejects duplicate submission
  by idempotency key.
- The deterministic test uses real SQLite, gateway, scheduler, messaging, and
  observer seams with fake Agent execution.

### Real Herdr/TraeX acceptance

`npm run smoke:headless-multi-agent -- --execute` must use the trusted project
checkout with isolated temporary state and a real Thread-Primary-equivalent
binding/pane, create an isolated derived Worker worktree through `createWorker`,
execute one Primary-to-Worker delegation,
verify exact Worker completion and no automatic Primary turn, restart durable
components, verify no replay, and clean only resources it owns.

The smoke must report `productPath: true` with explicit assertion fields. A
preflight result, full unit suite, or a run that fails before Worker creation is
not acceptance evidence.

### Required commands

Always run the focused Worker interaction tests, `npm run typecheck`, and
`npm run build`. Run the full `npm test` for persistence, scheduling, or shared
runtime changes. Run smoke preflight and the executed real smoke when the
Herdr/TraeX dispatch path changes. Completion requires every applicable layer
to pass against the current checkout.

## Verification Evidence

Evidence is recorded by the implementing change rather than frozen as historical
test counts in this contract. Every change to direct-reply routing must run the
focused instance-routing and SQLite-store tests plus typecheck and build. Changes
that alter persistence, scheduling, or shared runtime behavior additionally run
the full suite. The real smoke remains required when the Herdr/TraeX dispatch
path itself changes; a pure fail-closed lookup correction does not require live
Agent execution.
