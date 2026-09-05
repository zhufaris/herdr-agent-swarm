# Priority Steer Implementation Plan

## Objective

Make explicit steer a durable priority instruction for Primary and Worker
owners. A working owner receives native exact-turn steering. An idle owner
starts one priority turn ahead of ordinary FIFO work. Blocked and unknown
runtimes remain fail-closed.

## Invariants

- Every `/swarm` command continues through `SwarmCommandGateway`.
- Primary and Worker use one `TurnControlWorkflow` decision boundary.
- Priority intent is durable before any Herdr prompt effect.
- At most one runtime turn is authorized per owner.
- Ordinary FIFO order is unchanged and resumes after priority settlement.
- A prompt that may have reached TraeX is never replayed.
- Local approval and question states cannot be bypassed remotely.

## Batch 1: Durable priority-turn model

1. Extend Primary prompt and Worker turn kinds with an explicit priority
   classification and migrate SQLite checks without rewriting live rows.
2. Add acceptance APIs that atomically persist the priority turn, card intent,
   owner generation, and idempotency identity.
3. Change Primary and Worker claim transactions to choose priority work before
   ordinary FIFO work while retaining a single active-turn exclusion.
4. Extend recovery and durable scans so never-dispatched priority claims may be
   requeued, while dispatched or uncertain priority work is only observed.
5. Add store tests proving ordering, idempotency, generation fencing, and no
   replay after dispatch.

## Batch 2: Unified steer dispatch

1. Change `/swarm steer` policy scope from active turn to Primary session.
2. Refactor `TurnControlWorkflow.steer` to resolve a fresh owner state:
   - exact durable turn: call native steer and trust Herdr's exact-turn CAS;
   - idle runtime: persist and wake a priority turn;
   - blocked or unknown runtime: reject before terminal input.
3. Use one bounded re-resolution only after a proven no-effect native rejection
   so working-to-idle races can become priority turns safely.
4. Route Worker idle steer through the same boundary and existing Worker turn
   observer, preserving authorization and result-card behavior.
5. Add integration tests for Primary and Worker idle, stale coarse Herdr status,
   active-to-idle races, duplicate delivery, and blocked state.

## Batch 3: Presentation and operational verification

1. Update result cards, help, architecture, and Feishu usage docs to distinguish
   native injection from priority-turn acceptance.
2. Run focused store, turn-control, steering, Worker, and card tests.
3. Run `npm run typecheck`, `npm run build`, and `npm test`.
4. Commit each dependency-complete batch.
5. Install the immutable release and force-restart only after verifying the
   worktree and installed build identity.
