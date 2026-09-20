# Worker Transcript Detachment Recovery Design

## Goal

Keep an exactly identified Worker turn observable after the Herdr prompt command
returns a late `agent_prompt_stalled` or equivalent uncertain result. Preserve
live progress, capture the final answer, and complete the durable Worker turn
without resubmitting the prompt.

## Confirmed failure

The Worker scheduler opens a transcript watcher before prompt submission. The
watcher can claim the exact TraeX turn and persist its runtime turn ID and start
time. When `herdr agent prompt --wait` later reports a stalled or uncertain
settlement, the scheduler preserves the durable `running` state but immediately
stops the watcher.

Periodic recovery then calls `openAfterTurn`. While the turn is active, that
operation correctly fails closed because there is no completed boundary. After
completion, it opens a cursor after the terminal boundary, so no earlier answer
events are replayed. The fallback marks the turn completed from the existing
card answer. Because the detached watcher captured no progress, both the answer
and durable result are empty.

Production evidence for the affected reviewer turn showed:

- the exact runtime turn was claimed;
- TraeX continued producing commentary and tool events for about eight minutes;
- the Worker card stayed at an empty `running` projection;
- the transcript later recorded a full `task_complete` answer;
- periodic recovery marked the turn completed with an empty result.

## Design

### Detached live observation

`WorkerTurnWatch` gains a detach operation. Detaching transfers ownership of the
polling watcher from the scheduler's synchronous dispatch scope to the observer.
The watcher continues reading only the already opened transcript cursor. It does
not submit input, discover another session, or adopt another turn. Exact turn ID
and canonical start-time fences remain enforced by `WorkerTurnObserver.observe`.

The detached watcher stops itself when the durable turn becomes terminal. The
observer also tracks detached watches so service shutdown can stop and drain them
without writing after the shutdown fence. A watcher that never claims exact turn
identity is stopped normally and is never detached.

The scheduler detaches only when all of these are true after the driver settles:

- a structured watcher exists;
- the durable turn has both `runtimeTurnId` and `runtimeTurnStartedAt`;
- the durable turn is not terminal.

Otherwise the existing stop and uncertain-state behavior remains unchanged.

### Full transcript recovery

Recovery reopens at the exact turn start, not after its completion boundary. The
cursor drains the bounded transcript records for that exact turn and reconstructs
progress and the final answer. This is safe because every accepted observation is
fenced by runtime turn ID and start time, and card reducers are deterministic.
The scan remains subject to the existing bounded transcript size and drain limit.

If the exact turn is still incomplete, recovery leaves it running. If the start
boundary cannot be validated, recovery fails closed and does not infer completion
from Herdr's coarse idle state.

## Safety boundaries

- Never replay or resubmit the Worker prompt.
- Never treat `agent_status=idle` as proof that an exact TraeX turn completed.
- Never adopt output from another runtime turn or session generation.
- Stop detached watchers during service shutdown.
- Preserve FIFO blocking until the exact turn reaches a terminal lifecycle.
- Do not rewrite historical production rows as part of installation.

## Verification

- A deterministic integration test makes the driver return stalled after exact
  ownership, then emits progress and completion; both must reach the card after
  the scheduler drain has returned.
- A recovery test starts with an empty running card and a completed transcript;
  recovery must reconstruct the full final answer from the exact start boundary.
- Existing no-identity uncertain tests must remain unchanged.
- Shutdown tests must prove detached polling stops before lifecycle teardown.
- Run focused tests, the full Vitest suite, typecheck, build, architecture checks,
  and `git diff --check` before installation.
