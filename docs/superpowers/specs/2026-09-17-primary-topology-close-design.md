# Primary Topology Close Design

## Goal

Make `/swarm close` the confirmation-gated command for physically closing the
current Primary Herdr pane and, on a best-effort basis, the Worker panes owned
by that exact Primary binding generation. Keep `/swarm pane close` as a
compatibility alias for the same operation.

This replaces the current `/swarm close` behavior that only archives the Lark
binding while leaving Herdr panes running. It does not add remote process
killing, arbitrary terminal input, or automatic close replay.

## Command Contract

The canonical commands are:

```text
/swarm close
/swarm close confirm <code>
```

The existing commands remain accepted as aliases:

```text
/swarm pane close
/swarm pane close confirm <code>
```

The request command only creates a durable, actor-bound, short-lived
confirmation. It does not close any pane. The confirmation card names the
Primary pane, reports the currently discovered Worker pane count, and explains
that only safe Worker panes will close.

The confirmation command must be issued by the original actor before expiry. A
wrong actor, wrong code, expired request, changed Primary pane identity, or
changed binding generation rejects the operation without closing a pane.

## Safety Boundary

The Primary pane retains the existing strict safety gate. It may close only
when the binding is active and attached, the exact pane and runtime identity
still match, no Primary prompt is queued or actively supervised, and fresh
Herdr state is `idle` or `done`. A working, blocked, unknown, missing, or
identity-mismatched Primary rejects the whole confirmation before any Worker is
closed.

Workers use best-effort safety. A Worker is eligible only when all of these
conditions hold at confirmation time:

- it is an active Worker session owned by the exact binding ID, binding
  generation, and parent pane ID being closed;
- its runtime generation and pane identity still match the durable instance;
- its Herdr workspace, native session identity, and Agent kind match;
- its fresh Herdr state is `idle` or `done`; and
- it has no queued, claimed, dispatching, running, blocked, or
  dispatch-uncertain turn.

A Worker that is working, blocked, unknown, missing, busy, or identity-uncertain
is retained. It does not prevent other eligible Workers or the Primary from
closing. Workers belonging to another Primary, another binding generation, or a
sibling pane are outside the operation and must not be touched.

## Execution and Durable State

`PaneClosureWorkflow` remains the single application workflow for confirmation,
execution, and recovery. `/swarm close` and its compatibility alias route into
that workflow rather than `SessionAdministrationWorkflow.archive()`. This keeps
physical pane closure separate from ordinary binding lifecycle transitions and
reuses the existing durable close operation.

After the Primary passes its confirmation-time safety recheck, the workflow:

1. atomically snapshots eligible Worker close steps for the exact Primary
   ownership tuple;
2. fresh-observes each Worker and classifies it as eligible or retained;
3. closes eligible Worker panes one at a time and records each outcome;
4. closes the Primary pane;
5. transitions the Primary binding to closed and publishes the durable lifecycle
   result; and
6. sends a result card summarizing closed, retained, and uncertain Workers.

Successfully closed Workers have their Worker session terminated through the
existing instance lifecycle so queued turns are cancelled, possibly delivered
turns become uncertain, and Worker thread projections become stale. Retained
Workers remain active and attached to their surviving panes for local operator
inspection. The close operation does not delete worktrees, Worker records,
panes that failed safety checks, or Lark history.

If a Worker `closePane` call fails or its result cannot be proven, the step is
`uncertain`; the workflow still proceeds to the next Worker and then the
Primary. If the Primary close fails after some Workers close, the operation is
uncertain and reports the observed partial result. Closed Workers are not
recreated and prompts are never replayed.

## Recovery

Restart recovery observes unresolved Worker and Primary close steps against a
fresh Herdr snapshot. Pane absence confirms success; pane presence or an
observation failure remains retained or uncertain. Recovery never calls
`closePane` again, never sends terminal input, and never repeats a prompt.

The durable Worker step model must distinguish:

- `succeeded`: pane absence or a confirmed close;
- `retained`: safety deliberately prevented a close; and
- `uncertain`: a close may have happened but cannot be proven.

Retained and uncertain outcomes are terminal for automatic recovery. A later
operator action may inspect or close those panes locally.

## Presentation and Documentation

The confirmation card explains the topology scope and best-effort rule. The
result card reports total Worker panes considered and separate counts for
closed, retained, and uncertain outcomes. It must not claim that every Worker
closed when any pane was retained or uncertain.

Help, README, and `docs/feishu-group-usage.md` describe `/swarm close` as the
canonical physical topology-close command. They state that it requires
confirmation, closes safe Workers before the Primary, retains unsafe Workers,
and preserves history and worktrees. `/swarm pane close` is documented only as
a compatibility alias.

## Test Seams

Tests use the existing Lark command-to-durable-state/Herdr-call integration
seam in `tests/pane-close-integration.test.ts`, plus focused parser and card
tests. Required cases are:

- `/swarm close` issues confirmation without closing panes;
- `/swarm close confirm <code>` closes eligible Workers before the Primary;
- working, blocked, unknown, busy, or identity-mismatched Workers are retained
  while the Primary still closes;
- sibling Workers and Workers from older binding generations are untouched;
- an uncertain Worker close does not block Primary close;
- a Primary safety failure closes no Worker;
- recovery observes unresolved steps without replaying `closePane`;
- the legacy `/swarm pane close` commands remain equivalent aliases; and
- cards and documentation describe the new canonical semantics.

The implementation must continue to preserve exact identity fencing, local-only
high-risk Agent approval, durable outbox ordering, and the no-prompt-replay
invariant.
