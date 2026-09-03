# Feishu Model and Mode Selection Design

## Status

Approved design for making TraeX model changes explicit and durable in a bound
Feishu topic. This narrows the `/model` selector flow described by
`2026-08-25-durable-pane-control-commands-design.md`: the bridge must not
blindly confirm a TraeX mode with `Enter`.

## Problem

TraeX model selection can be a two-screen interaction:

1. `Select Model and Effort` lets the operator choose a model.
2. `Select Model and Mode` asks for a model-specific mode such as `Standard`
   or `Max`.

The current bridge chooses the model, detects the second screen, and submits
`Enter` automatically. This hides a meaningful setting from the remote
operator. It can also leave the terminal on the second selector if its timing
or presentation differs from the adapter's expected snapshot, while the Lark
card implies that the model was selected.

## Goals

1. Let the operator explicitly choose every TraeX mode selection that follows a
   model selection.
2. Derive model and mode options solely from the current TraeX selector; the
   bridge does not maintain a separate catalog.
3. Persist the inter-screen selection state so a service restart, Lark delivery
   retry, or duplicate card action cannot lose intent or repeat terminal input.
4. Preserve one non-stop terminal writer per binding and the existing rule that
   no prompt may start during model control.
5. Report a switch only after TraeX returns to a ready composer and the bridge
   can obtain fresh model state.

## Non-goals

- Remote approval of TraeX approvals or any other high-risk interactive screen.
- A bridge-owned static list of model modes.
- Choosing a mode without a preceding TraeX model selector.
- Automatically resuming an abandoned selector after its operation expires.

## Considered approaches

### Auto-confirm the default mode

This is the current behavior. It is small but hides a user-visible decision and
is vulnerable to selector timing or layout variation. It is rejected.

### Hold model state in memory until the second card action

This removes the blind `Enter`, but a restart loses the mapping between the
card, pane, requested model, and native selector. It conflicts with the
bridge's durable operation model and is rejected.

### Durable two-step selector operation

This is the selected approach. A model action advances one durable control
operation to a `waiting_for_mode` phase after TraeX has accepted the model
selection. The existing Lark card is updated with mode choices parsed from the
live terminal. A mode callback claims the same operation and completes the
native interaction exactly once.

## Data model and lifecycle

Reuse the existing `pane_control_operations` model for `kind = model`. While
waiting, its state is `applied` and its bounded JSON `detail` contains
`{ phase: "waiting_for_mode", model, modes, expiresAt }`. The operation's
existing `source_message_id` identifies the originating card; `pane_id`,
`terminal_id`, and `binding_generation` form the callback identity fence.

The operation remains binding-scoped and protected by the existing write fence.
It retains its idempotency key throughout both steps. The transition from
`applied` to `running` atomically claims the mode callback; later duplicate
callbacks observe the terminal state and never send duplicate text or Enter.

Lifecycle:

```text
model card action
  -> running (send model text + Enter once)
  -> applied + waiting_for_mode detail (persist live modes, update same card)
  -> running (atomically claim; send chosen mode text + Enter once)
  -> confirmed | uncertain | rejected
```

If TraeX has no Mode selector after the model choice, the adapter proceeds
directly to composer verification. This keeps models with a single native step
compatible without inventing an empty Lark card.

## Adapter contract

Split the current `selectPaneModel` abstraction into explicit, bounded native
selector operations. The adapter owns terminal reads, normalized selector
recognition, redaction, and exactly-once submission checkpoints; the workflow
owns durable transitions and Lark projection.

- `beginPaneModelSelection(paneId, model, timeout)` opens `/model`, selects the
  requested model, then returns either `mode_required` with the normalized
  model/mode options or `composer_ready`.
- `completePaneModelMode(paneId, selectedMode, timeout)` asserts that the live
  terminal is still the recognized mode selector, selects that exact mode, and
  waits for a ready composer.
- Unknown, ambiguous, stale, or timeout terminal states are not resolved with a
  blind Enter. They yield a safe `uncertain` operation result.

Native option labels are submitted by filtering/typing their exact label and
then pressing Enter, following the current model selector behavior. The adapter
does not rely on ordinal position, so the default highlight cannot change the
operator's requested choice.

## Lark cards and callback behavior

`renderModelResultCard` gains a mode-selector variant. It retains the original
card message and header identity, but replaces the model select element with:

- text identifying the selected model;
- a `select_static` element whose options are the parsed native mode labels;
- callback data carrying only the binding ID and durable operation ID.

The selected option arrives independently as the Lark callback option. The
router validates the operation exists, belongs to the callback chat and binding,
is in `waiting_for_mode`, has the same pane generation, and advertises the
selected mode. Invalid or expired callbacks update the originating card with a
bounded stale/expired result; they do not write to Herdr.

Cards show a neutral `选择运行模式` state after model selection, green only after
confirmation, and a clear uncertain state if the terminal outcome cannot be
verified. A model list request remains unchanged and simply renders model
choices.

## Recovery, expiry, and concurrency

While an operation is `waiting_for_mode`, it continues holding the binding's
non-stop terminal control lane. Prompt dispatch remains blocked for that binding
so no text can enter the native selector. The pending selection expires after
five minutes. The existing SQLite state enum is retained: `applied` represents
the durable waiting state, with `{ phase: "waiting_for_mode", model, modes,
expiresAt }` in `detail`. Expiry moves the operation to terminal state
`rejected` with `phase: "expired"` in the detail, updates the original Lark
card, and releases the prompt lane. It never presses Escape or replays model
input automatically. Operators can start `/model` again after the pane returns
to a safe composer state.

On startup, the coordinator reloads non-terminal model operations. An unexpired
`waiting_for_mode` operation remains eligible for its persisted callback and a
new local expiry timer is scheduled. An already expired operation is rejected
immediately. Recovery deliberately does not infer selector state from terminal
text and sends no text or Enter without a fresh operator callback.

## Verification

Tests must prove:

1. a model selection with native modes updates the same card to actual TraeX
   mode options and sends no default-mode Enter;
2. a selected mode submits that exact label once, returns to a composer, and
   results in a confirmed green card only after verification;
3. modes are parsed from current terminal output and no static catalog is used;
4. duplicate model/mode callbacks, restart recovery, stale callbacks, and expiry
   never repeat terminal input;
5. queued prompt dispatch cannot interleave with either selector phase;
6. models with no mode selector still complete via composer verification;
7. selector layout/timeout/identity failures are safe, visible uncertain results
   rather than automatic confirmation; and
8. focused adapter, integration, SQLite migration, typecheck, build, and full
   test suites remain green.
