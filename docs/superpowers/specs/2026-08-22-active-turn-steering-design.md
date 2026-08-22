# Active-turn steering design

## Goal

When a Lark reply arrives while a bridge-managed TraeX turn is actively working,
the bridge should feed that reply into the current turn as steering instead of
waiting for a later FIFO turn. The bridge must preserve durable receipt, event
deduplication, per-message status, ordering, and the existing Herdr-only approval
boundary.

This design supersedes the MVP rule that prompts are never injected into an
active turn. FIFO remains the safe fallback whenever the bridge cannot prove that
the target pane is in a steerable working state.

## User-visible semantics

Every accepted Lark message remains an independently persisted request with its
own request card. A message is eligible for steering only when, at acceptance
time, all of the following are true:

- the binding is active and has a pane;
- this bridge process owns an active `runPrompt()` for the binding;
- that active run has a known prompt ID; and
- the latest structured Herdr agent state is `working`.

An eligible request is associated with the active prompt and ordered behind any
earlier steering requests for that same binding. Its card progresses from
`queued` to `running`, then completes with an acknowledgement such as "已加入当前
执行". It does not receive a copied or guessed final answer. The active prompt's
card remains the single owner of the turn's streamed output and final answer.

Messages accepted while the pane is `blocked`, `idle`, `done`, or `unknown`, or
while no bridge-owned run is active, are ordinary FIFO prompts. They are not
retroactively converted into steering after the agent becomes working again.
This prevents text entered during approval from being mistaken for approval UI
input and keeps queue behavior predictable.

## Architecture

### Durable dispatch classification

Prompt persistence records a dispatch kind of `turn` or `steering`, plus a
nullable `parent_prompt_id`. A normal request uses `turn` and has no parent. A
steering request uses `steering` and names the currently running prompt.

Classification and insertion happen once during prompt acceptance. The existing
unique constraint on `lark_message_id` remains the idempotency boundary, so a
redelivered Lark event returns the existing request and can never inject the text
twice. The coordinator's in-memory active-run registry supplies the active prompt
identity and latest observed state; the durable fields preserve the decision for
cards, audits, and restart recovery.

The existing FIFO claim operation selects only `turn` requests. A separate
steering claim selects the oldest queued `steering` request for the active parent.
This prevents a pre-existing FIFO request from being silently reinterpreted as
steering.

### Single owner of the active turn

Each binding continues to have exactly one drain worker and exactly one
`runPrompt()` waiter. `runPrompt()` owns state observation, streamed output, and
completion detection for the active turn. Steering never starts another waiter.

The coordinator maintains a per-binding steering chain while that worker is
active. The chain serializes steering requests in acceptance order and prevents
their `send-text` and Enter commands from interleaving. When the active turn
settles, its steering chain is closed before the worker claims the next FIFO turn.

### Herdr adapter contract

`HerdrPort` gains a distinct `steerPrompt(paneId, text)` operation. Immediately
before writing, the adapter reads structured pane state and proceeds only when it
is still `working`. It then sends the text and Enter through Herdr pane commands.
It does not wait for turn completion and does not parse output.

The preflight result is explicit:

- `injected`: both commands completed, so the request is marked delivered;
- `not_working`: no input was attempted, so the request is converted to a normal
  FIFO turn;
- an error after command execution begins: delivery is uncertain, so the request
  fails with an actionable card and is never replayed automatically.

There is an unavoidable time-of-check/time-of-use window because Herdr does not
provide an atomic "inject only into this turn" primitive. The bridge minimizes
it by requiring both a live bridge-owned run and an immediate structured-state
preflight. It must not claim stronger delivery guarantees than Herdr provides.

## Data and event flow

For an eligible steering message:

1. Persist the inbound event and request card as today.
2. Persist the prompt as `steering` with the active prompt as its parent.
3. Publish the queued event and deliver the initial request card.
4. Append the request to the binding's serialized steering chain.
5. Claim it once, publish `SteeringStarted`, and run the adapter preflight.
6. On injection, mark it delivered and publish `SteeringDelivered`; its card
   acknowledges incorporation into the parent turn.
7. Continue observing and rendering output only on the parent request card.

If preflight returns `not_working`, the store atomically changes the request to a
normal queued turn with no parent, publishes a queue-state update, and schedules
the normal worker. If injection is uncertain, it publishes `SteeringFailed` and
the card asks the user to inspect Herdr and resend if needed.

## Ordering and races

- Lark event deduplication occurs before classification.
- Steering is serialized per binding in durable creation order.
- Steering never jumps ahead of an earlier steering request.
- Existing FIFO requests stay FIFO even if a later message is classified as
  steering. This is intentional: the later message modifies the current turn,
  while the earlier request explicitly belongs to a future turn.
- Once the parent leaves `working`, unclaimed steering requests fall back to FIFO.
- A `working` to `blocked` transition closes steering eligibility immediately.
  Approval remains possible only in Herdr.
- A `working` to `done` race is handled by the adapter preflight when observable;
  the residual Herdr command race is reported honestly as described above.

## Restart recovery

Restart recovery favors at-most-once steering over silent duplicate execution:

- queued `turn` requests retain the existing FIFO recovery behavior;
- queued `steering` requests cannot safely target their old parent after restart
  and are converted to normal FIFO requests;
- a `steering` request left `running` may already have reached the terminal, so it
  is marked failed with an uncertain-delivery explanation and is not replayed;
- the parent running prompt follows the existing running-prompt recovery policy.

This policy may require a user resend after a crash, but it cannot execute the
same steering instruction twice automatically.

## Safety boundary

- `blocked` is never steerable, even if terminal text appears active.
- Lark exposes no approve, deny, keypress, stop, or arbitrary pane-control action.
- TraeX continues to start with `--permission-mode auto`.
- `bypass_permissions`, `danger-full-access`, and equivalent modes remain
  prohibited.
- Only normalized Lark message text is sent; bridge commands continue through
  their existing command path.
- A steering failure cannot cause automatic replay.

## Scope of the implementation

The change includes prompt schema migration, store claims and recovery, the
adapter steering operation, coordinator active-run bookkeeping, steering events,
request-card projections, and tests. It also updates the MVP design's FIFO-only
statements and acceptance criteria to reference this design.

Fixing unrelated orphan-topic and unmentioned top-level-message feedback remains
separate work. Steering must not hide those routing outcomes.

## Tests and acceptance criteria

Automated coverage must demonstrate:

1. A message accepted during a bridge-owned `working` turn is persisted as
   steering, injected once, and does not start a second `runPrompt()` waiter.
2. The steering request has its own card, while output and the final answer remain
   exclusively on the parent request card.
3. Multiple steering messages are injected in durable acceptance order without
   interleaved pane commands.
4. A duplicate Lark event returns the existing request and is not reinjected.
5. Messages received while `blocked`, `idle`, `done`, `unknown`, or without an
   active bridge-owned run remain FIFO.
6. A steering preflight that observes a non-working pane converts the request to
   FIFO without sending text.
7. A command failure after injection begins is marked uncertain and is not
   automatically retried.
8. On restart, queued steering falls back to FIFO and running steering is failed
   without replay.
9. Existing approval lifecycle, FIFO processing, graceful shutdown, and Lark
   delivery tests continue to pass.

Live validation must show a second Lark reply steering a deliberately long-running
turn in the bound Herdr pane, with no second turn waiter and no regression in
`/health`, `/ready`, or graceful PM2 restart logs. Live validation must not use a
high-risk action or remote approval.
