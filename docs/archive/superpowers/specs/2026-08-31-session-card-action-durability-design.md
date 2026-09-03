# Session Card Action Durability Design

## Status

Approved for implementation design. This specification covers Session card
actions only. Worker and Instance card actions remain outside this change.

## Problem

The Lark card callback currently validates and consumes a `card_interactions`
row before it invokes the workflow that performs the requested operation. Some
of those workflows call Herdr or perform multi-stage provisioning. If the bridge
stops after the interaction is marked `consumed` but before the workflow has
durably accepted the operation, the button becomes a false success: a repeated
callback is treated as already handled even though the requested action may
never have started.

The repair must not turn every Session action into a blindly replayed generic
job. Existing workflows already encode different safety semantics:

- pane control has durable `pane_control_operations` and never replays an
  operation whose terminal input may already have been sent;
- reset provisioning has binding checkpoints and deliberately refuses to create
  another pane after an uncertain creation boundary;
- confirmed pane close has its own `pane_close_requests` state machine and
  recovers by observing pane presence rather than replaying close;
- archive and other SQLite-owned transitions can be committed atomically without
  an external command queue.

The missing abstraction is therefore durable action acceptance into the owning
workflow, not a second universal command executor.

## Goals

- Eliminate the `consume interaction -> accept operation` crash window for
  Session card actions.
- Return from Lark callbacks after durable acceptance for actions that continue
  asynchronously.
- Reuse the owning workflow's checkpoints and recovery policy.
- Preserve no-replay behavior whenever an external Herdr side effect may have
  happened.
- Make outstanding Session action work visible through aggregate-only status
  diagnostics.
- Keep socket or in-process events as wake-up hints; SQLite remains the durable
  authority.

## Non-goals

- Migrating Worker or Instance card actions.
- Introducing event sourcing or treating `lifecycle_events` as a complete log.
- Remotely approving high-risk TraeX actions.
- Automatically retrying a pane creation, pane input, rename, reattach, or close
  after its outcome becomes uncertain.
- Storing a complete Lark callback payload or unbounded form contents in a
  command table.

## Action classification

| Action | Acceptance and execution model | Recovery rule |
| --- | --- | --- |
| `session_status`, `view_queue`, `view_recovery`, open-form actions | Synchronous read/projection | Nothing to recover |
| `session_archive` | Accept into `session_operations`, then run the existing atomic binding transition, view projection, and outbox path | Durable binding state and outbox convergence are authoritative after handoff |
| `session_pane_close` | Accept into `session_operations`, then create the existing confirmation request and outbound card intent | No pane is closed at this stage; confirmed close retains the existing observe-without-replay recovery |
| `session_stop` | Accept into `session_operations`, then hand off to `pane_control_operations` and its existing control worker | Either authority becoming `running` is never blindly replayed |
| `session_reset` | Accept into `session_operations`, then create or resume the reset candidate through provisioning checkpoints | Never create a second pane after an uncertain creation boundary |
| `session_replace` | Accept a durable replacement operation with binding generation and pane identity fences, then run checkpointed provisioning | Observe a recorded pane/checkpoint; never blindly create another pane |
| `submit_reattach` | Accept a durable reattach operation containing only the validated pane ID and identity fences | Observe the target and current binding; retry only while no external mutation could have occurred, otherwise mark uncertain |
| `submit_rename` | Accept a durable rename operation containing a bounded validated title and identity fences | If Herdr and SQLite already agree, succeed; if neither changed, a pending operation may run; disagreement becomes uncertain |
| `session_resume` | Durable operation because Herdr identity must be observed before the SQLite activation | Pending work may observe; after an uncertain observation/transition boundary, converge from Herdr and SQLite rather than replaying mutation |
| `session_model` | Accept into `session_operations`, then hand off to the existing durable model control | Existing pane-control/model recovery remains authoritative |

## Durable acceptance boundary

Each mutating callback first calls the Session operation acceptance method. That
transaction must:

1. validate interaction ownership, expiry, binding ID, and binding generation;
2. validate the action kind and its bounded structured arguments;
3. create or find the durable Session operation using an interaction-derived
   idempotency key;
4. mark the interaction consumed only after the durable Session operation exists;
5. commit before publishing a wake-up or returning a success Toast.

A duplicate callback returns the previously accepted operation only after actor
ownership is revalidated. It must not create another operation. A legacy
consumed interaction with no matching operation is stale, not a successful
duplicate. If validation or insertion fails, the interaction remains active so
the user can retry.

Store methods return an explicit outcome such as `accepted`, `duplicate`,
`unauthorized`, `expired`, `stale`, or `rejected`. Coordinators do not infer an
outcome by rereading partially updated rows.

## Session operation state

Operations that do not already have an adequate domain table use a focused
`session_operations` table. It is an inbox for Session workflow intent, not a
generic command bus.

Required fields are:

- operation ID and unique interaction-derived idempotency key;
- binding ID and expected binding generation;
- expected pane ID and terminal ID when the action addresses a pane;
- actor Open ID and source interaction ID;
- a constrained operation kind;
- bounded structured arguments encoded by kind;
- state: `accepted`, `running`, `succeeded`, `rejected`, `failed`, or
  `uncertain`;
- attempt count, bounded diagnostic detail, and timestamps.

The table must not contain the raw Lark event, card JSON, secrets, terminal
output, or prompt content. Rename titles and pane IDs use existing boundary
validation and explicit size limits.

Every mutating Session callback first enters this table so interaction
consumption and durable handoff share one transaction. The dispatcher then
hands stop/model to `pane_control_operations`, reset to binding provisioning
checkpoints, and pane close to `pane_close_requests`; those workflow-specific
records remain the authority once accepted. Rename, reattach, replace, and
resume complete directly from the Session operation workflow.

## Dispatch and event behavior

A coalescing single-flight Session operation dispatcher drains accepted work in
creation order. Acceptance follows durable-before-wake:

1. commit the operation;
2. emit a scoped wake-up for the binding;
3. return the accepted Toast.

The dispatcher reloads the operation and current binding before execution. It
claims with an atomic `accepted -> running` transition and rechecks binding
generation plus pane and terminal identity fences. A stale operation is
rejected without calling Herdr.

The wake-up is best effort. Startup recovery starts the dispatcher over accepted
operations, and its periodic anti-entropy scan uses the configured reconciliation
interval, so a lost event changes latency but not eventual execution. Shutdown
stops new claims before waiting for the currently observed operation.

## Recovery and no-replay policy

On startup:

- `accepted` operations remain eligible for dispatch.
- Every `running` operation is conservatively treated as potentially
  side-effecting and marked `uncertain`. It is not replayed. Any downstream
  workflow-specific authority already created before interruption retains its
  own recovery and reconciliation behavior.
- Fine-grained observation that can prove a completed rename, reattach, or
  provisioning outcome may later promote an uncertain operation, but is not
  required for safe acceptance and is not part of this implementation.

An ordinary transport error after an external call also produces `uncertain`,
not an automatic retry. Failures that occur before the external-call boundary
may return to `accepted` only when the implementation can prove no mutation was
attempted.

## User-visible results

The callback success Toast means "durably accepted", not "external operation
completed". Final success, rejection, failure, or uncertainty is projected
through the existing main-card/outbox path. The exact final message is
idempotent per operation.

Uncertain results must say that the bridge did not replay the operation and
tell the user to inspect or refresh the Session state before trying again. They
must not expose raw adapter errors or sensitive arguments.

## Status and retention

`/status` reports aggregate Session operation counts for `accepted`, `running`,
and `uncertain`, plus the age of the oldest accepted operation and dispatcher
state. No argument, title, pane value, or raw error is returned. An accepted
head older than five minutes degrades operational status without changing
readiness.

Terminal Session operations share the configured durable-history retention
window and are pruned in their own bounded batches. `accepted`, `running`, and
`uncertain` rows are never removed by retention.

## Migration and compatibility

The SQLite migration is additive. Existing consumed interactions cannot be
reconstructed safely and are left unchanged. New callbacks use the atomic
acceptance methods after migration. Existing pane controls, reset candidates,
and pane-close operations keep their current recovery semantics.

No Lark card schema change is required. Existing callback values remain valid;
the bridge derives idempotency from the current interaction and validated
binding metadata.

## Testing strategy

Focused store tests must prove:

- operation creation and interaction consumption are atomic;
- duplicate callbacks return the existing operation;
- unauthorized, expired, and stale actions create no operation and do not
  consume the interaction;
- identity fences prevent dispatch after binding or pane replacement;
- retention deletes only old terminal rows.

Integration tests must inject failures at each crash boundary:

- after callback validation but before transaction commit;
- after commit but before wake-up;
- after claim but before an external call;
- after an external call but before the success checkpoint;
- during shutdown and startup recovery.

The tests must verify that pending work converges, uncertain work is not
replayed, duplicate callbacks do not duplicate Herdr calls, callbacks return
after durable acceptance, and final cards are delivered through the outbox.
The full workflow, store, health, typecheck, build, and Vitest suites remain the
release gate.
