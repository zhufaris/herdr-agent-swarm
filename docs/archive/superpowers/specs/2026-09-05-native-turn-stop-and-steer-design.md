# Native Stop and Priority Steer Design

## Goal

Provide two explicit, durable controls for a Primary or Worker runtime:

```text
/swarm stop
/swarm steer <instruction>

/stop <worker>
/steer <worker> <instruction>
```

`stop` interrupts the exact active turn. `steer` is a priority instruction: it
injects guidance into an exact active turn when one exists, or starts a new
priority turn immediately when the runtime is idle. It never joins the ordinary
FIFO and never reorders or cancels the ordinary backlog.

The queue-freezing replacement workflow in
`2026-09-05-steer-replace-queue-preemption-design.md` remains deferred. Priority
steer is narrower: it does not interrupt a working turn, freeze a queue, or
require an explicit resume.

## Why one priority-steer boundary

Three shapes were considered. Rejecting steer while idle leaves an unusable gap:
ordinary text waits behind the FIFO while the explicit priority command cannot
run. Treating steer as an ordinary prompt with a priority number would duplicate
Primary and Worker scheduling rules and could race an active runtime. The full
replace workflow would interrupt work and freeze the queue, which is stronger
than the requested behavior.

The selected design keeps `TurnControlWorkflow` as the shared Primary/Worker
boundary and gives steer two effect modes selected from a fresh owner state:
`native-steer` for a working exact turn and `priority-turn` for an idle runtime.
The boundary serializes both modes with stop and normal dispatch for the same
owner. Primary and Worker adapters remain thin command-facing wrappers.

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

`/swarm steer <instruction>` targets the current Primary runtime.
`/steer <worker> <instruction>` targets the selected Worker runtime.

The behavior is state dependent:

```text
working + exact turn -> native steer into that turn
idle                 -> dispatch one durable priority turn immediately
blocked              -> reject without terminal input
unknown              -> reject until reconciliation establishes a safe state
```

The idle path bypasses queued ordinary work but does not mutate its order. Once
the priority turn settles, normal dispatch resumes from the original FIFO head.
If the owner changes from idle to working during dispatch, the workflow
re-resolves the fresh exact turn and uses native steer; it must not start a
second concurrent turn. If it changes from working to idle before native steer,
the native exact-turn compare-and-swap rejects the stale target and the workflow
may perform one fresh resolution to dispatch the same durable operation as a
priority turn, provided no external effect may have occurred.

Steer remains unavailable while the runtime is blocked on local interaction.
Native steering capability is required only for the working mode. Text
containing words such as `stop` or `--replace` is ordinary steering content and
does not change the operation kind.

## Priority turn and ordinary FIFO

An idle steer is persisted as a priority turn before any Herdr prompt effect.
It has a stable logical turn ID, owner generation, source identity, payload,
dispatch fence, result projection, and idempotency key. It reuses the existing
Primary or Worker turn observation and settlement pipeline but is claimed only
by the priority path.

Ordinary acceptance remains open. Existing and newly accepted ordinary turns
stay in FIFO order while a priority turn is pending or running. The ordinary
claim transaction must reject a claim whenever an owner has a dispatchable or
possibly-running priority turn. The priority claim transaction must reject a
claim whenever any ordinary or priority runtime turn is already active.

Only one priority turn may be pending or running per owner. A later steer against
an idle owner is serialized behind the first priority operation rather than
creating concurrent work. No priority turn that may have reached Herdr is ever
returned to a dispatchable state or automatically replayed.

## Exact target and effect fencing

Both controls persist a `TurnControlOperation` containing:

- owner kind and ID;
- project and owner generation;
- pane ID;
- native agent-session identity;
- effect mode, `native-steer`, `priority-turn`, or `interrupt`;
- durable logical turn ID, once resolved or created;
- native runtime turn ID when targeting an existing turn;
- actor and source identity;
- operation kind and steer payload, when applicable;
- idempotency key, state, result, and timestamps.

Before claiming an accepted operation, the workflow obtains a fresh Herdr pane
observation and verifies generation, pane, native session, agent state, and any
runtime turn identity. The store atomically records the selected effect mode and
changes `accepted` to `dispatching` before the adapter is called. A duplicate
idempotency key returns the existing result and never repeats the external
effect.

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

Working-mode steer calls Herdr's native agent-steer request with pane, native
session, runtime turn, text, and idempotency key. Herdr performs the final exact
turn compare-and-swap; a coarse `agent_status` observation is not sufficient to
override a durable exact turn identity. Idle-mode steer uses the same formal
agent prompt boundary as an ordinary turn, but through the priority claim path.
Adapters validate structured results and never log the steer payload.

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

All `/swarm` commands continue to enter through `SwarmCommandGateway`. Steer is
scoped to a Primary session rather than requiring an active-turn context, so an
idle Primary can accept it. The immutable command context captures the Primary
generation; `TurnControlWorkflow` performs the fresh state and runtime identity
resolution immediately before selecting an effect mode.

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
- Stop, steer, priority-turn dispatch, and ordinary claim are serialized by the
  owner lane. At most one runtime turn is authorized at a time.
- A native not-active result is eligible for one fresh mode resolution only when
  the result proves no effect was sent. Delivery-uncertain is terminal and never
  retried or converted into a priority turn.
- Natural turn completion racing with control dispatch is safe: revalidation
  rejects before the effect when completion is already visible; otherwise the
  observer settles the durable turn from authoritative transcript/runtime data.
- A bridge restart never turns an interrupted or uncertain turn back into queued
  work.

## Component changes

- Extend `TurnControlWorkflow` with shared state resolution and explicit
  native-steer, priority-turn, and interrupt effect modes.
- Add durable priority-turn acceptance and claim methods to the Primary and
  Worker store ports without changing ordinary FIFO ordering.
- Make ordinary Primary and Worker claims observe the priority-turn exclusion in
  the same transaction.
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
- Change `/swarm steer` policy scope from active-turn to primary-session and
  update help and Feishu usage documentation with idle priority behavior.

## Testing and verification

Focused tests cover:

1. Primary and Worker stop/steer parsing, including the legacy Worker alias.
2. Working steer uses exact native turn and session fences even when coarse
   Herdr status is stale.
3. Idle steer starts before an existing ordinary backlog while preserving that
   backlog's order.
4. Idle-to-working and working-to-idle races never authorize two turns.
5. Blocked and unknown states reject without terminal input.
6. Persist-before-effect ordering and one external call for duplicate requests.
7. Stop acknowledgement without premature durable turn settlement.
8. Transport failure and restart recovery preserve non-replayable uncertainty.
9. Serialization of stop and steer targeting the same turn.
10. Primary and Worker cards that omit steer payloads and expose safe outcomes.
11. All text and card entry points reaching the same control workflow.

Run the focused command, adapter, turn-control, Primary concurrency, Worker
messaging, observer, and card suites, then `npm run typecheck`, `npm run build`,
and the full `npm test` suite.

## Non-goals

This design does not freeze, reorder, prioritize, or cancel queued work. It does
not automatically submit replacement work after stop, resend uncertain effects,
infer turn settlement from a result card, remotely answer approval prompts, or
close the pane or agent process.
