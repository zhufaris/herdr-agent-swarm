# Worker Transcript Detachment Recovery Implementation Plan

**Goal:** Preserve live and final Worker transcript output after prompt transport
settlement detaches, without replaying the prompt.

## Task 1: Lock the live-detachment regression

- Extend the Worker messaging integration fixture with a controllable transcript
  cursor.
- Claim an exact turn, return `agent_prompt_stalled`, then emit later progress and
  completion after `scheduler.drain()` returns.
- Assert that the card receives progress and the final answer without another
  driver submission.
- Run the focused test and confirm it fails on the current implementation.

## Task 2: Add detached watcher ownership

- Extend `WorkerTurnWatch` with an explicit detach lifecycle.
- Track detached watches in `WorkerTurnObserver`; stop them automatically after a
  terminal durable transition.
- Make `InstanceWorkScheduler` detach only exact-owned nonterminal turns and stop
  all other watches normally.
- Ensure service shutdown awaits watcher shutdown before store teardown.

## Task 3: Lock and fix full recovery

- Add a recovery test where the card is empty but the exact transcript contains
  the full completed turn.
- Change recovery from the after-completion cursor to the exact start cursor.
- Drain only observations matching the persisted runtime ID and start time.
- Remove the empty-result completion fallback unless a validated terminal
  lifecycle has been observed.

## Task 4: Verify and deploy

- Run focused Worker scheduler, observer, and supervisor tests.
- Run `npm test`, `npm run typecheck`, `npm run build`, architecture checks, and
  `git diff --check`.
- Commit the implementation.
- Run `./install.sh` and `npm run swarm:restart -- --force`.
- Verify build identity, readiness, lease health, Worker observer counts, and a
  fresh Worker turn if a non-destructive production check is available.
