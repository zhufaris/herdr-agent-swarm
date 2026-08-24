# Agent Detection Reconciliation Design

## Problem

Herdr can temporarily report `agent_status=unknown` and omit the pane from the
snapshot agent list even though the pane foreground process is TraeX. The bridge
then retains stale binding state and can leave a detached turn or its following
FIFO entries apparently queued. A production example was `wH:p18`: structured
agent state was unknown, while `pane process-info` showed the exact `traex`
executable and terminal output showed the ready composer.

## Decision

Use layered, fail-closed runtime evidence for already-bound panes:

1. Structured Herdr agent state remains authoritative when it is not `unknown`.
2. For an `unknown` pane, inspect `pane process-info`. Continue only when an
   executable basename is exactly `traex`.
3. Read a bounded terminal tail and classify only strong TraeX markers:
   - a visible composer near the tail means `idle`;
   - a current working marker means `working`;
   - a current approval prompt means `blocked`;
   - otherwise the state remains `unknown`.
4. Reconciliation updates the binding with the normalized state and schedules
   its FIFO worker. Detached observers use the same terminal classifier to
   recognize completion without replaying the original request.

No inference may be made from pane title, cwd, historical output alone, or a
failed process probe. Unknown remains unknown when evidence is incomplete.

## Architecture

The Herdr adapter owns evidence collection because it is the boundary that
understands snapshot, process-info, and terminal commands. It exposes panes with
normalized `foregroundExecutables` and agent state. The reconciliation module
consumes that normalized model and remains responsible only for binding state,
events, and worker scheduling. Terminal marker parsing is implemented as a pure
runtime helper shared by normal prompt observation and detached recovery.

To avoid turning every workspace snapshot into an expensive N-pane probe, the
adapter enriches only the unknown panes requested by reconciliation. Structured
states and unbound discovery keep the snapshot fast path. A bound-pane lookup may
explicitly request runtime evidence when recovery depends on it.

## State and Queue Semantics

- `unknown -> idle`: update the binding, complete a detached observation only
  when the ready composer is visible, then schedule the next queued turn.
- `unknown -> working`: update the binding and keep the current observer attached.
- `unknown -> blocked`: update the binding but do not drain new work.
- `unknown -> unknown`: do not dispatch, replay, or close anything.
- A queued prompt is never marked delivered merely because the pane looks idle.
- A dispatched prompt is never sent again during detection recovery.

## Failure Handling

Process-info and terminal-read failures are logged as bounded diagnostics and
leave the state unknown. A pane disappearing during the probe follows the normal
orphan threshold. Conflicting terminal evidence also remains unknown. Recovery is
idempotent, so repeated Herdr events and periodic reconciliation are safe.

## Verification

Tests cover:

- snapshot `unknown` plus exact TraeX process plus composer becomes idle;
- a shell process or missing process evidence stays unknown;
- working and blocked terminal markers do not become idle;
- reconciliation updates a stale bound pane and wakes its FIFO;
- detached recovery completes the old turn and drains the next prompt without
  replaying the old prompt;
- existing structured-state, pane-close identity, and full-suite tests remain
  green.

Production verification checks `wH:p18`, `/ready`, the durable queue, and the
latest project/answer card state after restarting the native plugin.
