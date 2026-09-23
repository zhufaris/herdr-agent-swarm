# Runtime Event Module Depth

## Goal

Make the Herdr event shutdown path and its runtime/composition seams easier to
understand by removing shallow forwarding interfaces and concentrating ordered
event behavior in the modules that own it. Preserve all current durability,
cancellation, and shutdown behavior.

## Design principles

This refactor optimizes for fewer, deeper modules. A composition seam must hide
meaningful behavior or wiring; it should not exist only to forward the same
arguments to another object. Event admission, coalescing, and real settlement
remain local to `HerdrSocketSubscriber`. Scope-specific reconciliation and
ordered Primary observation remain local to `HerdrEventRouter`.

The deletion test guides the change: deleting a shallow forwarding method
should remove code rather than spread conditionals across callers. No new
module is introduced unless it hides behavior needed by more than one caller.

## Interface changes

Define the Herdr hint consumer seam as one function that accepts a normalized
hint and the event-lifecycle `AbortSignal`. The subscriber already owns that
signal and supplies it for every admitted callback, so the production seam does
not need optional cancellation.

`RuntimeEventIntegration` keeps ownership of connecting the router during
composition, but it no longer exposes a shallow `handleHerdrHint()` proxy. The
bridge composition captures the connected consumer function once and passes it
directly to infrastructure construction. Existing event reliability metadata,
lifecycle fan-out, and work wakeups remain in `RuntimeEventIntegration`.

Direct router callers may continue to omit a signal for tests and bounded
internal use. That compatibility belongs to the router interface, not to every
composition layer.

## Router deepening

`HerdrEventRouter` owns one private operation for the ordered Primary chain:

1. reconcile bindings for the selected scope;
2. after reconciliation settles, check the event-lifecycle signal;
3. start Primary transcript observation only when cancellation has not fired and
   the scope provides an eligible observation target.

Pane, workspace, and full routes supply only their scope and observation target.
They no longer repeat promise continuations with subtly different cancellation
conditions. Independent instance reconciliation, instance observation, and
retired-pane work still start together and remain part of real callback
settlement.

The router continues to coalesce concurrent hints under the lifecycle signal of
the active drain. Production uses exactly one subscriber-owned event lifecycle
signal. This is an explicit internal invariant, not a new multi-caller scheduling
contract.

## Subscriber lifecycle

`HerdrSocketSubscriber` remains the deep module for socket admission and event
settlement. It continues to:

- own one event-lifecycle `AbortController`;
- reject new ingress before draining;
- merge pending hints;
- discard pending work after shutdown cancellation;
- await the active callback's real promise before reporting drain completion;
- remove the shared shutdown listener after draining.

Small private helpers may name shutdown-signal linking or pending-hint removal
when that makes invariants visible, but they must not create another lifecycle
module or allow abort to stand in for settlement.

## Behavioral boundaries

This refactor does not:

- change event routing, invalidation, or reconciliation scope;
- pass cancellation into existing Herdr commands or SQLite transactions;
- cancel, replay, retry, or synthesize a TraeX prompt;
- change SQLite schema, lease fencing, writer classification, or shutdown order;
- change Lark delivery, CardKit rendering, configuration, or operator commands;
- add restartable subscriber semantics or multiple event lifecycle owners.

## Testing

Characterization tests must preserve no-signal direct router use, the single
subscriber-owned signal, coalesced follow-up cancellation, ordered Primary
checkpoints, and active callback settlement. Tests at the composition seam must
assert direct function connection without depending on a forwarding method.

Before completion, run focused event and managed-runtime tests, typecheck, build,
the full Vitest suite, architecture check, documentation audit, public audit,
and diff check. Review the result independently against repository standards and
this design.
