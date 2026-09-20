# Pane-scoped Worker lifecycle

## Status

Approved design. This document defines the target behavior before implementation.

## Problem

The current Worker record is project-scoped and can survive the loss of its
Herdr pane. The service can then start that same record in a new pane because
the associated git worktree still exists. That is misleading: the worktree can
survive, but the Worker session, agent context, terminal state, approvals, and
in-flight turn identity cannot be transferred to a new pane.

The service currently stores only a `sourcePrimaryPaneLabel`, which is display
metadata rather than a stable parent identity. Closing a Primary pane does not
find or close its derived Worker panes.

## Decision

A Worker is a durable record of a **derived pane session**, not a reusable
project-level agent. SQLite remains the durable source of Worker history, turn
state, audit data, and close operations, but the Worker session lifetime is
bounded by its parent Primary pane and its own Worker pane.

The relationship is:

```text
Primary binding / Primary pane
  -> zero or more derived Workers
       -> one dedicated Worker pane and one Worker session
       -> one isolated worktree lease
```

The worktree is a separate filesystem asset. It may be retained after a Worker
terminates, but retaining it never makes the terminated Worker session
restartable.

## Persisted identity

Replace the informational parent label as the lifecycle authority with immutable
parent identity fields on each newly created Worker:

- `parent_binding_id`: the active Primary binding that created the Worker;
- `parent_pane_id`: the exact recorded Primary pane at creation;
- `parent_native_session_id`: nullable diagnostic/fencing identity observed for
  that parent pane when available;
- `source_primary_pane_label`: retained only as historical/display metadata.

Worker creation requires a live, recorded Primary binding and a matching
observable parent pane. There is no longer an `unbound` Worker creation path.

## Lifecycle rules

### Create and start

- Creating a Worker persists its parent identity and creates its isolated
  worktree lease.
- Its first start allocates one dedicated Worker pane and attaches the Worker
  runtime to that pane.
- Worker starts must verify that the recorded parent binding still owns the
  recorded parent pane and that the parent pane runtime identity still matches
  when one was captured.

### Worker pane loss or closure

- If the Worker pane is externally closed or its runtime identity changes, the
  Worker becomes `terminated`; it is not a detached/restartable Worker.
- The Worker accepts no new turns after termination.
- Queued turns that never started become terminal `cancelled` with the reason
  that the Worker pane/session ended.
- Claimed, dispatching, running, blocked, and dispatch-uncertain turns become
  terminal non-replayable outcomes. The exact state/reason must preserve that a
  close occurred after dispatch may have begun; no turn returns to the queue.
- The Worker pane is never silently replaced and a terminated Worker cannot be
  started in a fresh pane.

### Parent Primary pane closure

Confirming a Primary pane close is explicit authority to cascade the close to
every currently derived Worker. The close must not be blocked merely because a
child has active or uncertain work.

The single durable close operation performs this ordered transition:

1. Identify Workers whose immutable parent identity matches the binding and
   exact Primary pane being closed.
2. Fence each Worker from future dispatch and terminalize all of its turns using
   the rules above.
3. Request closure for every recorded Worker pane. A failed or ambiguous pane
   close remains durable as an uncertain close operation and is never blindly
   replayed.
4. Mark each Worker `terminated` after its pane is observed absent, or retain a
   close-uncertain terminal diagnostic if that absence cannot yet be proven.
5. Close the parent Primary pane and archive its binding.

This is logically a cascade: the Primary is not treated as reusable once the
operation is accepted. Recovery may observe outstanding pane-close effects but
must never dispatch a child Worker turn again.

### Explicit Worker-pane close

Closing an individual Worker pane terminalizes that Worker and its turns under
the same no-replay rules. It does not close the parent Primary pane or sibling
Workers.

## Recovery and compatibility

`detached` remains meaningful only while the original recorded pane/session is
still plausibly present and awaiting authoritative Herdr reconciliation. Once
reconciliation establishes that a Worker pane is missing or mismatched, the
Worker transitions to the non-dispatchable terminal lifecycle.

Existing Worker rows cannot be safely assigned a parent pane from their stored
label. Migration therefore marks them as legacy session records:

- they remain readable for history, audit, and safe worktree-removal planning;
- they cannot be newly started or adopted by a pane;
- they do not participate in new parent-pane close cascades;
- operators may explicitly stop or remove them using the existing safe removal
  flow.

## Operator and card behavior

- A live Worker card identifies its parent Primary pane/binding and dedicated
  Worker pane.
- A terminated or legacy Worker card is historical and must not offer Start,
  Restart, Rebind, or Attach actions. It may offer inspection and the existing
  stop/removal actions when their safety preconditions hold.
- A parent close confirmation/result describes how many Worker panes and turns
  were cascaded, including close-uncertain cases.

## Failure handling and invariants

- No cascade retries a TraeX turn or reuses a Worker runtime identity.
- All Worker-turn and Worker-lifecycle changes use generation fences and SQLite
  transactions.
- Pane close calls remain external effects. Persist the requested lifecycle
  intent before calling Herdr, and recover only by reconciling observed pane
  state.
- A worker pane may only be closed when its record proves service ownership; no
  unrecorded pane is adopted or closed by the cascade.
- Worktree retention/removal remains governed by the existing clean/dirty
  inspection and explicit confirmation flow.

## Implementation scope

1. Extend domain records, store schema/migrations, ports, and row mappings with
   parent identity and terminal Worker lifecycle state.
2. Require and verify parent identity during Worker creation and first start.
3. Change runtime reconciliation and scheduling so missing/mismatched Worker
   runtimes terminalize the session and its turns instead of leaving a
   restartable detached instance.
4. Extend `PaneClosureWorkflow` and durable close-operation recovery to execute
   the ordered Worker cascade.
5. Update cards, Lark interaction handling, command text, architecture docs,
   and tests.
6. Add migration coverage for legacy Worker records and integration coverage for
   active/uncertain child turns during a parent close.

## Non-goals

- Rehydrating a Worker session in a different pane.
- Automatically reusing a retained Worker worktree for a new Worker.
- Adopting arbitrary existing Herdr panes as Workers.
- Remotely interrupting or approving TraeX actions outside the existing local
  Herdr safety boundary.

## Verification strategy

Focused tests must cover:

- Worker creation rejects missing, changed, or unobservable parent pane identity.
- A normal Worker retains one parent identity and one first runtime pane.
- Missing/mismatched Worker pane terminalizes the Worker and prevents a start.
- Parent close cascades all matching Worker panes and never touches siblings or
  Workers from another parent binding/pane.
- Queued work is cancelled and in-flight/uncertain work is terminalized without
  a second agent submission.
- Recovery from failures before and after each pane-close command never repeats
  a turn and converges based on a fresh Herdr snapshot.
- Legacy migration keeps old records inspectable but non-startable.

Run the affected Vitest integration and store suites, then `npm run typecheck`,
`npm run build`, and the full `npm test` because this changes persistence and
workflow recovery.
