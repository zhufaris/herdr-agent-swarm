# Durable Pane Control Commands Design

## Status

Approved direction for stabilizing `/model`, `/stop`, and `/steer`. This design
supersedes command-specific assumptions in earlier documents where they conflict
with the operation lifecycle defined here.

## Problem

The three commands currently write to one TraeX terminal through three different
reliability models:

- `/stop` sends `Esc` directly and has no durable operation record;
- `/steer` creates a durable prompt job, but waits for its Lark Answer Card before
  execution and may be converted into an ordinary FIFO turn;
- `/model` drives an interactive terminal selector synchronously after a non-atomic
  busy check and CardKit model actions have no durable deduplication record.

These differences create races, ambiguous results, replay risk after restart, and
user-visible commands that sometimes appear to do nothing. The runtime also uses
one `blocked` state for capacity waiting, high-risk approval, and other interactive
screens even though those states have different remote-control safety rules.

## Goals

1. Serialize all terminal-writing control commands per binding without delaying
   `/stop` behind ordinary work.
2. Persist command intent and outcome before relying on Lark delivery.
3. Never automatically repeat an external terminal action after it may have run.
4. Never turn explicit `/steer` text into a later ordinary prompt.
5. Keep high-risk approval local to Herdr.
6. Give every accepted, rejected, uncertain, and completed command visible and
   observable status.

## Non-goals

- Remote approval or rejection of high-risk TraeX actions.
- Process termination or pane closure through `/stop`.
- Moving ordinary prompt execution into a general-purpose job framework.
- Stabilizing unrelated slash commands in this change.

## Considered approaches

### Add more state checks in each command

This is small but leaves three independent race windows and restart behaviors. A
fresh preflight cannot prevent a turn from starting immediately after the check.

### Add one durable table per command

This gives recovery records but duplicates claim, fencing, deduplication, and
uncertain-result logic. It also does not provide one owner for pane input.

### One durable, binding-scoped control lane

This is the selected approach. One operation model owns acceptance, idempotency,
pane-input serialization, dispatch checkpoints, recovery, and status projection.
Command handlers retain command-specific eligibility and result interpretation.

## Runtime state classification

The bridge adds a control-oriented runtime classification separate from the broad
`AgentState` used by existing lifecycle views:

| Control state | Evidence | `/stop` | `/steer` | `/model` |
| --- | --- | --- | --- | --- |
| `working` | structured working state or bounded active-turn evidence | allow | allow | reject busy |
| `capacity_wait` | bounded terminal evidence for capacity/rate-limit queue while a supervised turn exists | allow | allow | reject busy |
| `approval_required` | approval prompt or structured approval evidence | allow | reject with Herdr guidance | reject busy |
| `interactive_blocked` | another recognized interactive screen | allow | reject with Herdr guidance | reject busy |
| `idle` / `done` | fresh composer/done observation with no active turn | reject | reject | allow |
| `unknown` | insufficient evidence | allow only with a supervised active turn | reject | reject |

`/stop` remains an `Esc` control, so it may exit a capacity wait, approval dialog,
or another supervised interactive state. It never approves an action. `/steer`
must not write text while an approval or unclassified interactive screen is active.

Runtime classification uses structured Herdr state first and bounded visible terminal
evidence second. Historical scrollback alone cannot classify the current screen.

## Durable operation model

Add `pane_control_operations` with these logical fields:

- `id`, stable `idempotency_key`, `binding_id`, `pane_id`, `terminal_id`;
- `kind`: `stop`, `steer`, or `model`;
- private command payload where required;
- optional `parent_prompt_id`;
- `state`: `accepted`, `running`, `applied`, `confirmed`, `rejected`, `failed`, or
  `uncertain`;
- `attempt_count`, bounded `detail`, actor and source-message/action identity;
- timestamps and observed pre/post runtime classification.

The idempotency key is stable across Lark retries. Message commands use the Lark
message ID plus command kind. Card actions include message ID, binding, action kind,
and selected value. Duplicate delivery returns the existing operation and never
repeats the terminal write.

`accepted -> running` is an atomic claim under the existing SQLite write fence. At
most one non-stop pane writer may be `running` for a binding. A `/stop` operation
may preempt the lane because Esc is the interruption mechanism, but it still has a
durable record and idempotency key.

The non-stop lane has priority over *queued* ordinary prompt work. A `/model`
operation may claim an idle pane before the next FIFO prompt begins, even when
ordinary prompts are queued. It never preempts a prompt whose turn has already
started: if a supervised active turn exists, `/model` remains accepted until that
turn reaches a fresh idle/done observation or the operation is rejected/expired.
`/steer` is eligible only for that active parent turn and never becomes ordinary
queued work.

Once terminal input may have been sent, the operation cannot return to `accepted`.
A crash or timeout yields `uncertain`; startup recovery observes current pane state
and updates projections but never repeats the input automatically.

## Command behavior

### `/steer <text>`

1. Confirm an active binding and supervised parent turn.
2. Classify the current pane using fresh evidence.
3. Reject `approval_required`, `interactive_blocked`, `idle`, `done`, and `unknown`.
4. Atomically accept a steering operation linked to the parent prompt.
5. Execute as soon as the control lane permits; Answer Card creation is independent
   and cannot gate terminal injection.
6. Confirm text appearance before Enter, preserving the existing uncertain-delivery
   rule.
7. If the parent ends before dispatch, finish the steering operation as `rejected`
   or `expired`. Never convert it to an ordinary turn.

The existing steering prompt representation may remain during migration, but its
claim eligibility must no longer depend on Lark card checkpoints, and all
`requeueSteeringAsTurn` paths for explicit steering are removed.

### `/stop`

1. Confirm an active binding and supervised turn.
2. Atomically accept and claim a stop operation using the Lark message ID.
3. Send Herdr `Esc` once and mark the operation `applied`.
4. Observe the pane for a bounded period. Mark `confirmed` if the active state
   changes to idle/done or the interactive screen exits; otherwise mark `uncertain`.
5. Persist a user-visible response: “Esc sent”, then “stopped” or “effect not
   confirmed”.

Restart recovery never sends Esc again. It only observes an `applied` or `running`
operation and resolves it to `confirmed` or `uncertain`.

### `/model [name]` and model CardKit actions

1. Atomically accept the operation and acquire the non-stop pane-input lane.
2. Refresh the pane and require `idle` with a ready TraeX composer and no running
   prompt work. Queued ordinary prompts do not block `/model`: the control lane
   claims the pane before ordinary FIFO dispatch, then ordinary dispatch resumes
   after the operation reaches a terminal state.
3. For listing, drive `/model`, capture the current selector, exit it, and confirm
   return to the composer.
4. For switching, use an explicit selector state machine: model selector, optional
   effort/mode selector, composer return, then current-model verification. Each
   phase has its own bounded timeout. Unknown screens stop as `uncertain_ui_state`;
   they do not trigger blind Enter presses.
5. Distinguish `not_applied`, `possibly_applied`, and `confirmed`. A verification
   failure after selection must not be reported as a definite switch failure.
6. CardKit actions always update the originating card with busy, stale, failed,
   uncertain, or confirmed status; no silent return remains.

## Projection and observability

Each operation has a deterministic status projection. Lark delivery uses the
existing durable outbox and does not participate in execution eligibility. Logs and
audit records include operation ID, kind, binding, pane, phase, runtime class, and
safe error category. Steering/model text is not logged.

Operational status reports active and uncertain pane controls, oldest operation
age, and the latest bounded outcome. An `uncertain` result is not counted as success.

## Migration and compatibility

The schema migration is additive and idempotent. Existing prompt jobs remain valid.
Queued explicit steering rows whose parent is no longer active are failed with a
clear notice during convergence; they are not converted to ordinary turns. Legacy
already-converted rows cannot be distinguished safely and are left unchanged.

The implementation can land in slices:

1. remove steering fallback and decouple the Answer Card gate;
2. add runtime control classification and approval-safe steering;
3. add durable stop operations and bounded confirmation;
4. add the shared non-stop lane and durable model operations;
5. add status projection, recovery, and operational metrics.

## Verification

Tests must prove:

- explicit steering never becomes an ordinary turn, including parent completion,
  state drift, restart, and missing Answer Card delivery;
- capacity wait accepts steering, while approval and unknown screens receive no
  text or Enter;
- duplicate `/stop` delivery sends exactly one Esc; restart after the Esc checkpoint
  observes without replay; successful and uncertain outcomes are visible;
- prompt dispatch and model selection cannot own pane input concurrently; duplicate
  model card actions execute once; a queued ordinary prompt cannot starve an idle
  model operation; busy and stale actions update the card;
- model selection distinguishes not-applied, possibly-applied, and confirmed states,
  including selector layout changes and verification timeout;
- migration, write-fence, shutdown, safety scan, outbox, and complete integration
  suites remain green.

After implementation, build and install the plugin, restart the managed service,
verify `/ready`, expected build identity, control-operation diagnostics, and one safe
live exercise for each command.
