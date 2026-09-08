# Worker Turn Settlement Evidence Design

## Problem

A TraeX Worker prompt can start successfully while `herdr agent prompt --wait`
later returns `agent_prompt_not_started`. The transcript observer may already have
durably claimed the exact runtime turn, but the late CLI result currently changes
the logical Worker turn to `failed`. The card then reports failure even though the
task is running or has completed. Replaying the prompt would be unsafe.

The production incident on 2026-09-08 demonstrated this ordering:

1. the Worker turn was accepted, claimed, and marked dispatching;
2. the transcript observer recorded `runtimeTurnId` and `runtimeTurnStartedAt`;
3. the CLI settlement returned `agent_prompt_not_started`;
4. the scheduler changed the exact-owned turn to `failed`.

## Decision

Exact transcript ownership is stronger evidence than a late CLI non-delivery
classification. Once a Worker turn has both `runtimeTurnId` and
`runtimeTurnStartedAt`, the scheduler must not convert it to `failed` based on a
`not-delivered` receipt. It keeps the turn observable and lets the existing exact
transcript observer or runtime reconciler determine the terminal outcome.

This change is deliberately local to Worker dispatch settlement. It does not add
a general evidence-ranking framework, change Herdr, alter Primary prompt
settlement, or repair historical rows.

## Runtime behavior

After the driver returns, `InstanceWorkScheduler` reloads the durable turn.
Existing terminal states remain authoritative. For a non-terminal turn:

- `confirmed-delivered` preserves the current structured-turn behavior;
- `delivery-uncertain` remains `dispatch-uncertain`;
- `not-delivered` becomes `failed` only when no exact runtime identity has been
  claimed;
- `not-delivered` with an exact runtime identity preserves the observable turn.

The expected incident state is `running`, because an active transcript lifecycle
already projects the turn to running. If exact ownership is claimed before an
active lifecycle projection becomes visible, the scheduler must still avoid a
terminal failure and leave the turn eligible for supervision. No branch resends
the prompt.

## Persistence and concurrency

The durable Worker turn remains the arbitration point. The scheduler reloads it
after the asynchronous driver call, so it observes transcript claims made during
CLI settlement. The existing generation and exact-turn fences continue to guard
later transcript transitions. No schema or migration is required.

## Tests

Add an integration regression that reproduces the incident ordering:

1. submit a structured Worker turn;
2. have transcript observation claim an active exact runtime turn;
3. return a late `not-delivered` driver receipt;
4. assert that the turn and card remain running, no `turn.failed` event is
   written, and the exact runtime identity is retained;
5. deliver the matching completed transcript lifecycle and assert normal
   completion.

Retain coverage for true non-delivery without transcript ownership and for a
late receipt after transcript completion. Run the focused integration test,
typecheck, build, and the full test suite because this changes shared Worker
dispatch state handling.

## Success criteria

- A proven runtime turn cannot be downgraded to failed by
  `agent_prompt_not_started`.
- A prompt with no evidence of starting still fails normally.
- The fix never replays a prompt.
- Exact transcript completion remains the terminal authority.
