# Two-phase In-topic Reset and Durable Retired-pane Cleanup

## Status and authority

This design replaces the handoff and old-pane retention rules in the archived
`2026-08-24-in-topic-session-reset-design.md`. It does not change `/herdr new`,
manual `/herdr pane close`, prompt replay policy, or the requirement that
high-risk TraeX approval remains local to Herdr.

## Problem

The current `/new [title]` implementation transfers the Lark topic from the old
binding to a new provisioning binding before creating the new Herdr pane. If
pane creation or TraeX startup fails, the old pane survives but the topic has
already lost its usable binding.

After a successful replacement, old-pane closure is also process-local. A
bridge crash between activating the replacement and closing the old pane loses
the cleanup intent. Retrying a close command blindly is unsafe because the
first request may have reached Herdr even when its result was not observed.

## Goals

- Keep the old topic binding usable until a replacement pane and TraeX runtime
  are confirmed ready.
- Transfer topic ownership exactly once in one fenced SQLite transaction.
- Preserve the existing rule that old queued work is cancelled and work that
  may have reached TraeX is detached, never replayed.
- Persist retired-pane cleanup intent in the same cutover transaction.
- Close only a verified idle or done pane with the expected workspace, project
  directory, pane ID, and terminal identity.
- Recover safely from interruption before, during, or after the Herdr close
  command.
- Make the Lark result explicit about whether the old pane was closed, retained
  because it was busy, or retained because safety could not be proven.

## Non-goals

- Stopping a working TraeX turn.
- Moving old prompts or output into the replacement session.
- Automatically approving terminal actions.
- Reusing the manual confirmation-code flow for automatic reset cleanup.
- Automatically deleting arbitrary archived panes.
- Providing exactly-once execution of the external Herdr close command. The
  guarantee is safe convergence by observation, not transport-level exactly
  once.

## User-visible behavior

In an active attached project topic, `/new [title]` creates a replacement in the
same project. Until that replacement is ready, ordinary topic messages continue
to belong to the old binding. To avoid an ambiguous ordering window, the bridge
serializes reset and prompt acceptance for that Lark scope: once reset has
entered cutover, later messages are accepted only against the new binding.

On success, the topic receives one result card with the new pane ID and one of
these old-pane outcomes:

- **Closed**: the old pane was verified safe, closed, and observed absent.
- **Retained while busy**: the old binding has running or queued work, or Herdr
  reports `working` or `blocked`. Its later output is not sent to this topic.
- **Retained for safety**: pane identity, current state, or close outcome could
  not be proven. The card points to the old pane for local inspection.

If replacement provisioning fails before cutover, the old binding remains the
active owner of the topic and continues to accept messages. The failed candidate
is retained for diagnosis. If an external pane may have been created, the card
instructs the user to inspect the Space and attach the survivor rather than
automatically creating another pane.

## State model

### Candidate binding

The replacement is stored as a normal provisioning binding with a new explicit
relationship to its predecessor and Lark scope reservation:

- `replaces_binding_id`: immutable old binding ID;
- `reserved_topic_id` and `reserved_root_message_id`: intended cutover scope;
- no current `topic_id` or `root_message_id` before cutover;
- normal provisioning checkpoints: `selected`, `pane_created`,
  `runtime_started`;
- `thread_created` and `activated` occur only during or after cutover.

Only one unfinished reset candidate may reserve a given old binding/Lark scope.
Duplicate delivery of the `/new` message resolves to the existing candidate and
never creates another pane.

### Retired-pane cleanup operation

A dedicated durable table records cleanup independently of the manual
confirmation-code table. Each row contains the operation ID, old and replacement
binding IDs, pane ID, expected workspace/project/terminal identity, actor, state,
attempt metadata, detail, and timestamps.

States are:

- `pending`: cutover committed; safety evaluation is due;
- `waiting_busy`: old work or runtime is not safe to close; periodic and
  event-driven reconciliation may reassess it;
- `executing`: the bridge is about to issue or may have issued the close;
- `succeeded`: pane absence was verified and the old binding is closed;
- `retained`: automatic cleanup ended because identity or safety could not be
  proven; operator inspection is required.

There is at most one cleanup operation for an old binding. Terminal states are
never automatically reopened.

## Workflow

### Phase 1: provision without taking the topic

1. Validate that the current binding is active, attached, configured, and owns
   the incoming Lark scope.
2. Atomically create or load the reset candidate keyed by the inbound message.
   The old binding and its prompts remain unchanged.
3. Create the Herdr pane and persist pane/terminal identity before starting
   TraeX.
4. Start TraeX and obtain a fresh targeted runtime observation. The candidate is
   eligible for cutover only when the expected pane exists, identity matches,
   TraeX is present, and the composer/runtime is ready.
5. If any external result is uncertain, stop automatic provisioning at the
   durable checkpoint. Do not create another pane on restart.

### Phase 2: atomic cutover

One fenced SQLite transaction:

1. Re-read and compare the old binding, topic scope, candidate, generation, and
   provisioning checkpoint. Abort if any identity changed.
2. Cancel old prompts that are still queued.
3. Mark old running prompts detached; they may have reached TraeX and are never
   replayed.
4. Dismiss pending old-binding Lark delivery intent so stale cards cannot update
   the topic after cutover.
5. Move current topic/root identifiers into the old binding's retired audit
   fields and archive it.
6. Assign the topic/root/status identifiers to the candidate and activate it.
7. Persist the initial replacement topic projection and status-card delivery
   intent.
8. Insert the retired-pane cleanup operation.
9. Record a reset audit entry and commit.

After commit, process-local notifications only wake projection, prompt, and
cleanup workers. They are never the source of durability.

## Cleanup safety and recovery

The cleanup worker always reloads SQLite and performs a fresh targeted Herdr
observation. It does not rely on a cached workspace snapshot or the binding's
last stored agent state.

Before close, all conditions must hold:

- old binding is archived and still references the expected pane;
- replacement binding is active and owns the reserved topic;
- old binding has no queued or running prompt rows;
- pane workspace, project directory, pane ID, and terminal ID match;
- TraeX is present and the fresh agent state is `idle` or `done`.

If old work or runtime is `working`/`blocked`, set `waiting_busy`. Herdr events
and the periodic safety scan wake it again. Unknown runtime, missing terminal
identity, mismatched identity, or unsupported observation is not considered
busy; it terminates automatic cleanup as `retained`.

Immediately before the Herdr call, atomically claim `pending` or `waiting_busy`
as `executing`. After the call:

- observed absent: transition the old binding from archived to closed and mark
  the operation `succeeded` in one transaction;
- observed still present: return to `waiting_busy` only if a fresh observation
  proves it is now busy, otherwise mark `retained` with the failure detail;
- timeout, process exit, or bridge restart while `executing`: never replay the
  close immediately. Recovery first observes the exact pane. Absence converges
  to `succeeded`; presence undergoes the full safety check before any new claim.

This mirrors the existing manual pane-close uncertainty rule while keeping the
operation types separate: manual close requires user confirmation and targets
an active binding; reset cleanup is created only by a successful cutover and
targets its archived predecessor.

## Concurrency and ordering

- A per-Lark-scope reset gate serializes reset candidate creation and cutover
  with prompt acceptance.
- A second `/new` while a candidate is provisioning returns its current state;
  it does not create another candidate.
- `/new` may be requested while the old pane is working. Cutover detaches the
  observer and leaves the pane running; cleanup waits until durable and live
  state both prove it is safe.
- An old observer completing after cutover may update only old prompt audit
  state. It cannot emit delivery intent to the retired topic scope.
- Cleanup claims use compare-and-set state transitions and the existing instance
  lease/write fence. Only one service instance may act on an operation.

## Components

- `BindingProvisioningWorkflow` owns candidate provisioning and invokes one
  atomic store cutover. It no longer closes panes inline.
- A `RetiredPaneCleanupWorkflow` owns safety evaluation, durable claims, Herdr
  close, recovery, and bounded periodic scans.
- The provisioning store port gains candidate creation/load and atomic cutover
  capabilities. A separate cleanup store port exposes only cleanup operations.
- `SqliteBindingStore` adds the additive schema, uniqueness constraints, atomic
  cutover, compare-and-set cleanup claims, and recovery queries.
- `HerdrRuntimeReconciler` emits scoped wake-up hints when a waiting old pane
  changes state. The cleanup workflow still reloads authoritative state.
- `InboundRouter` starts and stops the cleanup workflow and preserves the
  durable-before-wake rule.
- Lark cards render reset provisioning, cutover success, and cleanup outcome as
  distinct states instead of using the generic rejection card.

## Observability

Structured logs and `/status` expose:

- reset candidates by provisioning checkpoint;
- cleanup counts by state;
- oldest pending/waiting cleanup age;
- last cleanup success and failure;
- old binding ID, replacement binding ID, pane ID, operation ID, and outcome.

Prompt text, terminal output, credentials, and card payloads remain excluded. A
long-lived `pending`, `waiting_busy`, or `executing` operation degrades `/status`
but does not make `/ready` false by itself.

## Migration and compatibility

The migration is additive. Existing active and archived bindings remain valid.
There is no attempt to infer cleanup intent for historical `/new` operations;
only cutovers committed after this feature create cleanup rows.

The existing synchronous auto-close code is removed only after the cleanup
worker is wired and tested. Manual pane-close records and recovery remain
unchanged. The user guide and help card are updated to state that `/new` closes
only a safely verified idle/done old pane and otherwise retains it.

## Verification

Focused tests must prove:

1. candidate creation leaves the old topic binding and prompts untouched;
2. pane creation or TraeX startup failure leaves the old binding active;
3. duplicate `/new` delivery reuses one candidate and creates at most one pane;
4. cutover atomically archives the old binding, activates the candidate,
   detaches running work, cancels queued work, dismisses old pending outbox rows,
   creates the replacement projection, and inserts one cleanup operation;
5. a message concurrent with cutover belongs entirely to either the old or new
   binding, never a failed candidate or both;
6. old observer completion after cutover cannot update the current topic;
7. idle/done old pane with matching identity is closed and observed absent;
8. queued/running work and working/blocked runtime move cleanup to
   `waiting_busy` without calling close;
9. unknown or mismatched identity becomes `retained` without calling close;
10. a restart from `executing` observes before deciding whether another close is
    safe;
11. close success followed by a crash before SQLite completion converges to
    `succeeded` from pane absence;
12. cleanup failure never rolls back or marks the replacement failed; and
13. help and usage text match the implemented behavior.

Run the affected store, provisioning, prompt-concurrency, reconciliation, pane
close, health, and card tests, followed by `npm run typecheck`, `npm run build`,
`npm test`, and `git diff --check`. A real-user smoke check may observe the
configured bridge but must not issue `/new` or close a live pane automatically.
