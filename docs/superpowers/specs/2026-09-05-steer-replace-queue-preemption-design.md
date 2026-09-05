# Replace Steering and Queue Preemption Design

> Deferred in favor of the priority-steer behavior in
> `2026-09-05-native-turn-stop-and-steer-design.md`. Replacement remains a
> possible higher-level workflow for explicitly interrupting work and freezing
> a backlog. Normal steer now starts a priority turn while idle, but does not
> freeze or cancel ordinary FIFO work.

## Goal

Add an explicit replacement form of native steering that can preempt the active
turn and every queued ordinary turn without losing durable work or allowing two
turns to run concurrently:

```text
/swarm steer --replace <urgent task>
/steer <worker> --replace <urgent task>
```

Replacement steering freezes the target queue, interrupts an exact active
runtime turn when one exists, waits for Herdr to prove that turn has terminated,
and then runs one new emergency turn ahead of the frozen backlog. The backlog
remains frozen after the emergency turn settles until the user explicitly
resumes or cancels it.

Normal `/swarm steer <text>` and `/steer <worker> <text>` use priority-steer
semantics: inject into the exact active native turn, or start one priority turn
ahead of ordinary FIFO work while idle. They do not interrupt the active turn,
freeze the queue, or require an explicit resume.

## Why a durable queue barrier

Three implementation shapes were considered.

Adding a priority field to ordinary turns would make an emergency item easy to
claim first, but it would not safely coordinate an already-running turn, an
uncertain interrupt, or recovery after a process restart. Cancelling the backlog
and inserting an emergency item at its head would discard the distinction
between never-started and previously-started work and would prevent a later
resume.

The selected design introduces a durable queue-control aggregate and a durable
replace operation. The queue-control aggregate is a claim barrier; it does not
rewrite ordinary FIFO ordering. The replace operation records the exact runtime
being displaced, the one-shot interrupt effect, termination evidence, and the
emergency turn authorized to pass the barrier. SQLite therefore remains the
source of truth for intent and recovery while Herdr remains the source of truth
for live runtime identity and termination.

## Scope and target identity

Queue control is scoped to the exact owner generation:

- Primary work is scoped to a binding and its current generation.
- Worker work is scoped to an agent instance and its current generation.

Every replace, resume, cancel, reobserve, and abandon transition checks that
generation. A stale command or recovery worker cannot affect a replacement
created for a newer binding or Worker runtime. Exact pane, native session, and
runtime turn identities additionally fence any interrupt.

The same domain workflow serves Primary and Worker targets. Command routing may
resolve those targets differently, but it must not duplicate preemption rules in
the two message handlers.

## Persistent state

Each current-generation target can have one queue-control aggregate containing:

- the target kind and durable target ID;
- the target generation;
- queue mode, `open` or `frozen`;
- a stable freeze ID and freeze timestamp while frozen;
- the current replace operation ID, when replacement has not been abandoned or
  completed administratively;
- the current authorized emergency turn ID, when one exists.

A replace operation contains:

- its target, generation, freeze ID, request identity, and urgent text reference;
- the displaced durable turn ID, if an active turn existed;
- the displaced pane ID, native session ID, and runtime turn ID captured before
  interruption;
- the emergency turn ID once emergency work becomes eligible;
- its phase and timestamps;
- the interrupt effect fence and recorded outcome;
- diagnostic information for an uncertain termination observation.

The replace phases are:

```text
interrupt-required
interrupt-requested
awaiting-termination
termination-uncertain
ready-to-dispatch
emergency-running
emergency-settled
abandoned
```

`interrupt-requested` means the external command may have reached Herdr. It is
not permission to resend the command. `awaiting-termination` and
`termination-uncertain` both deny emergency dispatch until a fresh observation
proves that the captured runtime turn is no longer active.

Emergency work is represented as a normal durable turn with an explicit link to
its replace operation and an emergency dispatch classification. It receives the
same run-card, transcript observation, settlement, and outbox behavior as other
turns. It is not inserted into or reordered within the ordinary FIFO backlog.
Every ordinary turn blocked by a freeze is durably associated with that freeze
ID: the freeze transaction associates the existing never-started backlog, and
ordinary intake associates later arrivals while the barrier remains active. This
explicit membership makes resume and cancel independent of timestamp races.

## Starting a replacement

The replace workflow first resolves the target and reads a fresh Herdr snapshot.
It then performs one atomic SQLite transition that freezes an open queue or
retains its existing freeze, records the new replace operation, and captures the
active durable and runtime identities when present. New ordinary work can be
accepted immediately after this transition, but no ordinary claim can pass the
barrier.

If there is no active runtime turn, the operation moves directly to
`ready-to-dispatch`. Creation of the emergency turn and its authorization to
cross the barrier occur atomically. A queued but never-started ordinary turn is
not treated as active and remains in the frozen backlog.

If an exact active runtime turn exists, the workflow sends at most one native
interrupt using its captured pane, session, and runtime turn identity. The
external-effect fence is persisted before the command can be sent. Success,
failure, or an uncertain command result is recorded without making the prompt
eligible. A successful interrupt request still requires a later fresh Herdr
observation; command acknowledgement alone is not termination evidence.

After reconciliation proves the captured runtime turn has ended, one transaction
settles the displaced durable turn as `cancelled`, creates or activates the
emergency turn, and moves the replacement to `ready-to-dispatch`. A displaced
turn that reached dispatch, including an emergency turn, is never returned to
queued state and is never automatically replayed.

## Dispatch barrier

Ordinary claim methods must consult queue control in the same transaction that
claims work. When the current target generation is frozen, they claim no
ordinary turn. This applies to Primary prompt jobs and Worker instance turns.

The emergency claim path is separate and narrow. It can claim only the one turn
whose replace operation and emergency turn IDs match the target's current
queue-control aggregate, whose phase permits dispatch, and whose generation is
current. Claiming it advances the operation to `emergency-running` atomically.
No other emergency or ordinary turn can be active for that target.

Queue acceptance remains open while frozen. New Lark messages and `/to` tasks
are durably appended to the ordinary FIFO tail and receive their normal queued
cards. They cannot be dispatched until a later resume. This makes the freeze a
dispatch policy, not an intake outage. Existing queue-depth limits continue to
apply.

## Continuous replacement

A new `steer --replace` may supersede an emergency turn. The target remains
frozen and the new operation becomes current. If the previous emergency is
active, the new operation captures its exact runtime identity, executes the same
one-shot interrupt protocol, and waits for confirmed termination before
authorizing the newer emergency turn. The displaced emergency settles as
`cancelled` and is never replayed.

If a previous replace is waiting for uncertain termination, a new replace cannot
bypass that uncertainty because doing so could create concurrent runtime turns.
The user must first reobserve until termination is proven or abandon that replace
under the rules below.

Only the current replace operation may authorize an emergency turn. Late
callbacks or observations for a superseded operation are generation- and
operation-fenced and cannot reopen dispatch.

## Queue controls

The command surface is:

```text
/swarm queue resume
/swarm queue cancel
/queue <worker> resume
/queue <worker> cancel
```

The corresponding target card exposes `恢复队列` and `取消队列`. These actions
carry the target generation and freeze ID so an old card cannot control a newer
freeze.

Resume is allowed only after the current emergency turn has definitively settled
and no replacement is awaiting termination. It atomically changes the queue to
`open`, closes the freeze, and wakes the ordinary dispatcher. FIFO order is
preserved. Only work that has never started remains eligible; interrupted,
running, dispatch-uncertain, completed, failed, or cancelled work is not replayed.

Cancel has the same eligibility gate. It atomically marks every never-started
ordinary turn belonging to the current freeze as `cancelled`, including work
accepted after the freeze began, closes the freeze, and emits durable projection
intent for affected cards. Records and cards remain available for audit; no turn
is physically deleted.

Resume and cancel are idempotent for the same target generation and freeze ID.
They are rejected while an emergency is active or termination is uncertain.

## Uncertain termination and recovery controls

When the service cannot prove that the displaced runtime turn ended, the replace
operation enters `termination-uncertain` and fails closed:

- the queue remains frozen;
- the emergency turn is not created or is not dispatchable;
- the interrupt is not automatically retried;
- ordinary and emergency claim paths both remain closed.

The card exposes `重新观察` and `放弃 replace`. Reobserve requests a fresh Herdr
snapshot and runs normal reconciliation. It never resends the interrupt. If the
captured runtime turn is absent, reconciliation records its termination. If a
different runtime turn is active, the captured turn may be settled but emergency
dispatch remains blocked until the target is also proven idle. If evidence is
still insufficient, the operation remains uncertain.

Abandon cancels the not-yet-started emergency intent and closes the replace
operation, but deliberately leaves the ordinary queue frozen. It is allowed only
when a fresh observation establishes that neither the captured displaced turn nor
an emergency turn from the operation is running. The user can then explicitly
resume or cancel the backlog. Abandon is not a way to declare a possibly-running
turn dead.

Service startup and periodic reconciliation inspect unfinished replace
operations. They may reobserve exact runtime identity, settle confirmed
termination, create an authorized emergency turn, or wake an already authorized
emergency turn. They must never resend an interrupt whose effect fence indicates
that delivery may have occurred.

## Commands and presentation

Parsing treats `--replace` as an option only in the exact position shown in the
new steer forms. Missing urgent text is a validation error. Existing steer text
that merely contains `--replace` elsewhere remains ordinary steering text. Queue
commands require exactly their documented target and action, preventing urgent
text or Worker names from being parsed ambiguously.

Run and target cards show whether the queue is frozen, why it is frozen, the
current replacement phase, and whether operator action is required. Buttons are
derived from durable state:

- `恢复队列` and `取消队列` appear only after emergency settlement;
- `重新观察` appears while termination is uncertain;
- `放弃 replace` appears only when abandonment can be evaluated safely.

Button actions enter through the same command workflow and idempotency checks as
text commands. Coordinators emit domain events and durable outbox intent; they do
not patch Lark cards directly. Lark state is never used to infer queue state.

## Failure and concurrency behavior

All transitions that jointly affect queue control, a replace operation, a turn,
and projection/outbox intent are transactional. Conflicting replace, resume, or
cancel requests serialize on the target generation and freeze ID. Duplicate Lark
events return the existing operation result rather than creating another
emergency turn.

The workflow preserves these invariants:

- At most one runtime turn is authorized for a target at a time.
- No emergency turn starts until termination of the displaced exact runtime turn
  is confirmed.
- No external interrupt is automatically replayed after it may have reached
  Herdr.
- Ordinary FIFO order is unchanged across freeze and resume.
- A turn that may have started externally is never made dispatchable again.
- Runtime actions are fenced by target generation, pane, session, and runtime
  turn identity.
- Workflow intent and card delivery intent are durable before external delivery.

Native steering and interruption remain unavailable for blocked approval state.
Replace, queue, and card controls cannot approve high-risk TraeX actions; approval
remains local to Herdr.

## Component changes

- Domain commands gain explicit replace-steer and queue-control variants rather
  than overloading normal steering.
- A queue-preemption workflow owns freeze, replacement, recovery-control, and
  emergency-authorization decisions for both Primary and Worker targets.
- `TurnControlWorkflow` remains the boundary for exact native runtime validation
  and interruption. It does not own queue state.
- SQLite gains the queue-control and replace-operation records plus atomic
  transitions for freeze, authorization, settlement, resume, and cancellation.
- Ordinary Primary and Worker claim paths enforce the barrier; a narrow emergency
  claim path enforces current-operation authorization.
- `SessionReconciler` remains the single convergence path for event-driven,
  requested, periodic, and startup observation of interrupted runtime turns.
- Event reducers and CardKit renderers project durable replacement state and
  expose only currently legal actions.

## Testing and verification

Focused tests must cover:

1. Command parsing for Primary and Worker normal steer, replace steer, and queue
   controls, including ambiguous and missing arguments.
2. Replacement with an active ordinary turn, an active emergency turn, no active
   turn, and a non-empty queued backlog.
3. Exact generation, pane, session, and runtime-turn fencing before interruption.
4. Persistence of the interrupt effect fence before invocation and no automatic
   resend after success, failure, timeout, restart, or uncertain outcome.
5. Confirmation-gated emergency creation and dispatch.
6. Ordinary task intake during freeze, FIFO tail placement, queue-depth behavior,
   and denial of ordinary claims.
7. Continuous replacement without overlapping runtime turns or replaying the
   displaced emergency.
8. Resume restoring only never-started work in original FIFO order.
9. Cancel atomically settling the complete frozen backlog, including tasks
   appended after freeze, while retaining records and card projections.
10. Rejection of resume and cancel during an active emergency or uncertain
    termination.
11. Reobserve without interrupt replay, safe abandonment, stale-button
    rejection, duplicate-event idempotency, and recovery from every persisted
    replace phase.
12. Card actions and views for frozen, uncertain, emergency-running, and
    emergency-settled states.

Verification requires the affected command, store, steering, concurrency,
reconciliation, event, and CardKit suites, followed by `npm run typecheck`,
`npm run build`, and the full `npm test` suite. A production rollout additionally
requires immutable installation, the active-work restart safety gate, readiness
verification, and a live Primary and Worker exercise that does not use high-risk
approval state.

## Non-goals

This design does not add general priority queues, reorder ordinary FIFO work,
remotely approve TraeX actions, retry uncertain prompt or interrupt delivery,
infer runtime state from Lark, delete audit history, or change normal native
steering semantics. It also does not make a stuck queued item steerable when no
runtime turn exists; only the explicit replace workflow may bypass that backlog.
