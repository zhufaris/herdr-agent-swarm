# Native Turn Stop and Steer Design

## Goal

Provide two explicit, durable controls for the exact active Primary or Worker
turn:

```text
/swarm stop
/swarm steer <instruction>

/stop <worker>
/steer <worker> <instruction>
```

`stop` interrupts the active turn. `steer` injects guidance into that same
active turn. Neither command creates an ordinary queued turn, changes FIFO
order, freezes the queue, or falls back to submitting work after the target
turn ends.

This design replaces the immediate implementation proposed in
`2026-09-05-steer-replace-queue-preemption-design.md`. A future replace
workflow may compose queue freeze, native stop, confirmed termination, and an
explicit emergency submission, but those policies do not belong in either
native primitive.

## Why independent native primitives

Three shapes were considered. Keeping the current split implementation would
leave Primary stop as an unfenced Escape key and Worker interrupt as a separate
instance operation, while steer already uses an exact-turn workflow. Renaming
those paths would improve syntax without improving safety. Implementing the
full replace workflow now would combine turn control with queue policy and make
the basic stop action unnecessarily stateful.

The selected design extends `TurnControlWorkflow` with `stop` beside `steer`.
Both operations resolve and persist the exact target before any external effect,
share the same identity validation, and fail closed after an uncertain effect.
Primary and Worker adapters become thin command-facing wrappers over this one
workflow.

## Command semantics

### Stop

`/swarm stop` targets the current Primary turn in the command's topic.
`/stop <worker>` targets the current turn of the named Worker owned by that
Primary pane. The commands are valid only while an exact active turn is known.

Stop sends one interrupt request and returns after recording its immediate
delivery outcome. An acknowledgement such as “Ctrl+C sent” means only that the
interrupt may have reached the terminal. Authoritative Herdr observation and
the existing Primary or Worker turn observer determine when the turn actually
becomes aborted, cancelled, or idle.

Once termination is observed, the normal dispatcher may claim the next ordinary
FIFO item. Stop does not cancel queued work. It also does not automatically
replay the interrupted turn, because that turn may already have produced
external effects.

Stop is rejected when the pane is waiting on a local approval or question.
Remote turn control must not become a remote approval or denial mechanism.

### Steer

`/swarm steer <instruction>` targets the current Primary turn.
`/steer <worker> <instruction>` targets the current Worker turn. Steer injects
the text into the native active turn and never creates a new turn or queues a
fallback.

Steer remains unavailable when the exact turn is absent, has changed, is no
longer working, is blocked on local interaction, or lacks native steering
capability. Text containing words such as `stop` or `--replace` is ordinary
steering content and does not change the operation kind.

## Exact target and effect fencing

Both controls persist a `TurnControlOperation` containing:

- owner kind and ID;
- project and owner generation;
- pane ID;
- native agent-session identity;
- durable logical turn ID;
- native runtime turn ID;
- actor and source identity;
- operation kind and steer payload, when applicable;
- idempotency key, state, result, and timestamps.

Before claiming an accepted operation, the workflow obtains a fresh Herdr pane
observation and verifies generation, pane, native session, agent state, and
runtime turn. The store atomically changes `accepted` to `dispatching` before
the adapter is called. A duplicate idempotency key returns the existing result
and never repeats the external effect.

The state meanings are:

```text
accepted -> dispatching -> delivered
                      \-> rejected
                      \-> uncertain
```

`delivered` means the native request was accepted or sent, not that stop
termination has been observed. `rejected` proves no external effect was sent.
`uncertain` means the effect may have reached Herdr and must not be retried
automatically. Startup may dispatch only operations still in `accepted`; an
interrupted `dispatching` operation becomes `uncertain`.

## Herdr adapter contract

Steer continues to call Herdr's native agent-steer request with pane, native
session, runtime turn, text, and idempotency key. The adapter validates the
structured result and exposes delivered, rejected, unsupported, blocked, or
delivery-uncertain outcomes without logging the steer payload.

The installed Herdr CLI does not currently expose an exact-turn `agent
interrupt` command. Stop therefore uses a new `interruptAgent` port method. Its
adapter implementation receives the same exact target identity, performs a
fresh targeted pane read, and only then sends logical `ctrl+c` through `herdr
agent send-keys`. The adapter reports that the signal was sent; it does not
claim termination. The port shape allows a future Herdr exact-turn interrupt
API to replace this transport without changing workflow semantics.

Raw `sendEscape(paneId)` is not a valid workflow-level stop capability and is
removed from Primary stop. Worker stop no longer selects between driver
interrupt and `PaneHost.interruptPane`; all Lark and Primary-tool stop requests
use the exact `TurnControlWorkflow` path. Low-level interrupt helpers may remain
only for internal lifecycle operations that are not user turn controls.

## Context boundaries and routing

All `/swarm` commands continue to enter through `SwarmCommandGateway`. Its
immutable command context captures the current Primary generation and active
prompt ID. Immediately before execution, the gateway re-resolves active-turn
context; `TurnControlWorkflow` then performs the stronger runtime identity
validation.

Worker commands continue to enter through `InstanceInteractionWorkflow`, which
resolves the worker name within the current Primary ownership boundary. Both
Primary and Worker wrappers supply actor, source, result-card target, and a
stable idempotency key to `TurnControlWorkflow`; they do not implement their
own interrupt policy.

The preferred Worker command is `/stop <worker>`. The legacy
`/interrupt <worker>` spelling remains an input alias for one release and is
normalized immediately to the same stop command. Cards use the label `停止` and
the same underlying operation.

## Durable results and projections

Every accepted stop or steer request writes its result-card outbox intent in the
same durable transition as the operation state. Cards expose operation kind,
target, and safe status but never include steer payload text.

Stop cards distinguish:

- interrupt sent, awaiting authoritative runtime observation;
- rejected before sending because the exact target changed;
- delivery uncertain, with no automatic retry;
- unsupported native control.

The normal run and Worker-turn cards remain the authority-backed projections of
turn settlement. A control-result card does not independently mark a turn
cancelled, and no coordinator patches Lark directly.

## Failure and concurrency behavior

- At most one accepted control operation is claimed for a given idempotency key.
- Revalidation prevents a command captured for one turn from affecting its
  successor.
- A transport timeout or malformed response after dispatch is uncertain and is
  never replayed.
- Stop and steer aimed at the same turn are serialized by the target turn's
  control lane. Once a stop has been dispatched, later controls for that turn
  are rejected or remain behind it until fresh state proves applicability.
- Natural turn completion racing with control dispatch is safe: revalidation
  rejects before the effect when completion is already visible; otherwise the
  observer settles the durable turn from authoritative transcript/runtime data.
- A bridge restart never turns an interrupted or uncertain turn back into queued
  work.

## Component changes

- Extend `TurnControlWorkflow` with a shared resolve, revalidate, claim, dispatch,
  and recovery path for `steer` and `interrupt`.
- Extend `HerdrPort` and `HerdrCliAdapter` with identity-bearing
  `interruptAgent`; keep terminal key mechanics inside the adapter.
- Route Primary stop through `TurnControlWorkflow` and retire legacy
  `PaneControlOperation` stop dispatch.
- Route Worker stop through `TurnControlWorkflow` and remove user-facing driver
  and raw-pane interrupt selection.
- Add `/stop <worker>` parsing while retaining `/interrupt <worker>` as a
  temporary alias.
- Use one result-card reducer/renderer for both operation kinds, with no payload
  disclosure.
- Update help and Feishu usage documentation to describe exact-turn, no-fallback,
  and no-replay behavior.

## Testing and verification

Focused tests cover:

1. Primary and Worker stop/steer parsing, including the legacy Worker alias.
2. Exact generation, pane, native-session, logical-turn, and runtime-turn fences.
3. Rejection for idle, changed, unsupported, and locally blocked runtimes.
4. Persist-before-effect ordering and one external call for duplicate requests.
5. Stop acknowledgement without premature durable turn settlement.
6. Observer-driven cancelled settlement followed by the next FIFO claim.
7. Transport failure and restart recovery to non-replayable uncertainty.
8. Serialization of stop and steer targeting the same turn.
9. Primary and Worker cards that omit steer payloads and expose safe outcomes.
10. All text and card entry points reaching the same control workflow.

Run the focused command, adapter, turn-control, Primary concurrency, Worker
messaging, observer, and card suites, then `npm run typecheck`, `npm run build`,
and the full `npm test` suite.

## Non-goals

This design does not freeze, reorder, prioritize, or cancel queued work. It does
not automatically submit replacement work after stop, resend uncertain effects,
infer turn settlement from a result card, remotely answer approval prompts, or
close the pane or agent process.
