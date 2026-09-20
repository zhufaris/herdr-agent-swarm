# Exact Transcript Prompt Settlement

## Problem

Lark messages are accepted durably, but some Primary bindings remain blocked behind a `running` prompt after the TraeX pane has returned to `idle`. Later ordinary messages remain correctly FIFO queued and therefore appear to receive no response. The affected prompts either lost their attached waiter during restart or encountered Herdr's short lifecycle-change timeout even though the exact TraeX transcript turn continued and completed.

Pane `idle` is insufficient proof of completion. Treating it as completion could attribute another turn, an aborted turn, or an unobserved result to the prompt and would violate the no-replay boundary.

## Design

Prompt settlement uses the canonical TraeX transcript identity and lifecycle. A prompt may complete only when the observer owns an exact `turnId` and canonical `startedAt`, and the same lifecycle reaches `completed`. An `aborted` lifecycle remains a failure/uncertain outcome under the existing execution lifecycle rules. A different later turn never completes the old prompt.

The local Herdr TraeX shim intercepts supported `agent prompt ... --wait` calls. If native Herdr reports `agent_prompt_stalled` after dispatch, the shim continues reading the already-opened typed transcript cursor. It converts the command to success only after observing a fresh, post-dispatch turn and that exact turn reaching `completed`, while the pane still hosts the same managed TraeX session. It otherwise preserves Herdr's original failure.

Restart recovery continues to use `PromptRunWorkflow` detached observation. Exact-owned detached prompts reopen or retain their transcript cursor and settle only from the matching lifecycle. Legacy detached prompts without exact identity remain uncertain and are not replayed.

## Recovery and delivery

Completing the exact prompt atomically updates its durable state and projections before waking the next FIFO item. Existing outbox idempotency and CardKit sequencing remain unchanged. CardKit `300309` recovery is a separate delivery concern and is not used to infer workflow completion.

## Tests

- A managed TraeX prompt whose Herdr wait stalls returns success when its exact transcript turn subsequently completes.
- The shim preserves the original failure for missing identity, mismatched/later turns, aborted turns, session replacement, or timeout.
- An exact-owned detached prompt completes from its matching transcript lifecycle and releases the next FIFO prompt without redispatching the old prompt.
- A detached prompt without exact identity remains uncertain even when the pane is idle.

## Operational outcome

After deployment, durable safety scanning re-observes exact-owned detached prompts and releases affected queues when completion is provable. Any historical prompt lacking exact transcript identity requires explicit operator recovery and is never automatically replayed.
