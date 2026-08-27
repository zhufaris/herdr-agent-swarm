# Pause Queue and Edit Queued Prompts

Date: 2026-08-27
Status: Approved design

## Goal

Add a minimal Feishu workflow for stopping the current TraeX turn, holding the
remaining FIFO, editing or cancelling work that has not started, and resuming
the FIFO when the user is ready.

This feature is deliberately small. It does not add a general pause state
machine, queue reordering, batch operations, or automatic replay of interrupted
work.

## User experience

While a bridge-supervised turn is active, its Answer Card shows a `暂停` button.
Clicking it has two effects in this order:

1. The binding's FIFO is durably paused.
2. The bridge sends the same Herdr `Esc` used by `/swarm stop` to the active
   TraeX turn.

The interrupted turn reaches an existing terminal prompt state and is not put
back into the queue. Its card describes it as interrupted without introducing a
new prompt state. Once runtime observation confirms that no supervised turn is
active, that card shows `恢复队列`.

While the FIFO is paused, each ordinary prompt that is still `queued` shows:

- `编辑`: opens a Feishu card input form populated with the current request.
  Saving replaces the request body while preserving the prompt ID, creation
  time, and FIFO position.
- `取消`: marks the prompt cancelled. There is no undo action in this version.

While the FIFO is running, queued cards do not expose edit or cancel controls.
New ordinary messages received during a pause are accepted normally and remain
queued.

Clicking `恢复队列` clears the pause flag and wakes the binding worker. If a
supervised turn is still active, the action is rejected and the queue remains
paused. The user can retry after the current turn has ended.

## Durable model

Add one boolean column to `bindings`:

```text
queue_paused INTEGER NOT NULL DEFAULT 0
```

No new pause table or pause lifecycle is introduced. `queue_paused` is a
binding-level dispatch gate; queued prompt jobs continue to use their existing
`queued` state. The flag survives service restarts.

`claimNextDispatchablePrompt(bindingId)` must require `queue_paused = 0` in the
same atomic claim transaction. This is the authoritative enforcement point.
Scheduler hints may still arrive during a pause, but they cannot claim work.

The pause action must persist `queue_paused = 1` before sending `Esc`. This
ordering closes the race in which the current turn ends and the worker claims
the next prompt before the pause is durable. A duplicate pause callback is
idempotent. The queue stays paused even if sending `Esc` fails or has an
uncertain result.

Resume atomically changes `queue_paused` from `1` to `0` only after validating
that the binding and pane identity still match and no supervised turn remains.
After commit, it emits a normal binding wake-up. A duplicate resume is
idempotent.

## Card actions and authorization

The new controls use normalized Lark card actions and the existing configured
chat and user-origin checks. Each action carries only stable identifiers and an
action name; prompt text is submitted through the edit form and is not trusted
from stale card state.

Every callback re-reads SQLite and validates current state:

- Pause requires an active binding, matching pane generation, and a supervised
  active turn corresponding to the card's prompt.
- Edit and cancel require the same active binding, `queue_paused = 1`, an
  ordinary prompt in `queued`, and confirmation that the prompt belongs to that
  binding.
- Resume requires `queue_paused = 1`, matching pane identity, and no supervised
  active turn.

Any user already accepted by the bridge's configured-chat and user-origin
checks may use these controls in the bound topic. This minimal version does not
restrict edit or cancel to the user who originally submitted the queued prompt.

Stale, duplicate, or now-ineligible actions return a concise card response and
do not mutate state. Editing validates the replacement with the same non-empty
text and size constraints used for incoming prompt messages. Card action
idempotency uses the Lark callback/event identity already normalized by the
adapter.

## Atomic mutations and projection

Each state-changing callback records its durable workflow mutation and the
corresponding card-update intent in one SQLite transaction, following the
existing durable-outbox rule. No coordinator calls Lark directly.

- Pause sets the binding flag and projects the affected active and queued cards.
- Edit replaces `prompt_jobs.body`, updates the queued Run Card request text,
  and records its card update without changing queue order.
- Cancel changes the prompt to the existing `cancelled` terminal state, updates
  its Run Card, and refreshes queue positions for remaining queued prompts.
- Resume clears the binding flag and projects removal of queue-management
  controls before waking the worker.

The exact card rendering remains a pure function of durable binding, prompt,
and Run Card facts. Frozen Answer pages are not patched; these controls belong
only to the mutable task/status portion of a card.

## Failure and recovery behavior

- If pause persistence succeeds but `Esc` fails, the queue remains paused and
  the card says that queue pause succeeded while interruption is unconfirmed.
- If the service restarts, `queue_paused = 1` continues to block claims. Any
  running prompt follows the existing detached-observer/no-replay recovery.
- If edit or cancel loses a race with dispatch, the guarded update affects no
  row and the action is rejected. A running prompt is never rewritten.
- If resume delivery fails after its transaction commits, the durable outbox
  retries the visible update; the worker may proceed because SQLite, not the
  card, is authoritative.
- Missing or replaced panes use existing reconciliation behavior. The feature
  does not broaden remote approval or process-control authority.

## Compatibility and scope

`/swarm stop` keeps its current behavior and does not pause the FIFO. The new
card `暂停` action is intentionally distinct: it sets the durable dispatch gate
and then reuses the stop/Esc execution path. `/swarm steer` is unchanged.

This version does not include:

- pause/resume text commands;
- editing the current or completed prompt;
- queue reordering or batch editing;
- undo for cancellation;
- automatic replay of the interrupted prompt;
- remote TraeX approval, pane termination, or process termination.

## Verification

Focused tests must cover:

1. Pause persists before `Esc`, blocks the next atomic claim, and is idempotent.
2. An uncertain or failed `Esc` leaves the queue paused.
3. Restart recovery preserves the pause and does not replay the interrupted
   prompt.
4. Edit changes only a paused ordinary `queued` prompt's body/card and preserves
   FIFO order.
5. Cancel changes only a paused ordinary `queued` prompt and updates remaining
   queue positions.
6. Stale callbacks and edit/dispatch races are rejected without mutation.
7. Resume is rejected while a supervised turn remains; otherwise it clears the
   flag and wakes FIFO dispatch.
8. Card render and Lark callback normalization tests cover the three controls
   and edit form.

Before handoff, run the affected Vitest files, `npm run typecheck`,
`npm run build`, and the full `npm test` suite because this spans persistence,
workflow concurrency, recovery, and CardKit behavior.
