# Terminal Answer Quarantine Convergence Design

## Problem

The service reports `degraded` while readiness is healthy because eleven old
Answer delivery lanes remain actively quarantined. Ten contain failed
`stream_content` replies rejected by Lark with error `300309` (`streaming mode
is closed`); one contains a failed continuation-card creation rejected by the
local element-identity guard. Every affected prompt is terminal, every lane has
no pending reply, and the dead-letter rows already preserve the failure audit.

An active quarantine is correct while it prevents later delivery from crossing
an uncertain content boundary. It is no longer operationally active once the
prompt is terminal and the lane has no work left to protect. Leaving that state
active forever makes `/status` permanently degraded without identifying
actionable work.

## Decision

Extend `recoverStaleOutboxQuarantines()` with a terminal-lane convergence pass.
After the existing targeted rebuild and rollback attempts, it releases a stale
Answer quarantine only when all of these conditions hold:

- the quarantine is still `active`;
- its failed reply remains `dead_letter`;
- the reply belongs to an Answer lane and references a prompt;
- the prompt is terminal: `delivered`, `failed`, or `cancelled`, with
  `observation_state = 'completed'`;
- the Run Card is terminal: `completed` or `failed`;
- the lane contains no pending outbound reply.

The release action is `startup_terminalized`. The failed outbound reply remains
a dead letter with its original error and failure metadata. Existing Answer
pages and visible Lark cards are not mutated by this fallback. This pass does
not retry delivery, create a replacement card, submit a prompt, or advance a
prompt queue.

## Why release instead of rebuilding every old card

The canonical Run Card still contains the answer, but rebuilding a terminal
historical card is not always safe: some failures represent an unconfirmed
stream boundary, and the original card may have partial content that cannot be
compared atomically with Lark. Existing targeted recovery remains responsible
for cases where a bounded canonical rebuild is provably safe. The fallback only
retires a lock that protects no pending work; it does not claim the historical
card was fully delivered.

This preserves the distinction between durable audit and current operational
health: `deadLetters` continues to expose historical failures, while
`outboxQuarantines.active` represents lanes that still block work.

## Safety boundaries

The convergence query must not release a quarantine when any of these is true:

- its prompt is queued or running;
- prompt observation is not completed;
- the Run Card is not terminal or is missing;
- any pending reply exists in the same lane;
- the quarantine is unrelated to an Answer prompt.

The update and lane-head refresh run inside the existing immediate transaction.
Recovery remains idempotent: a second invocation finds no newly terminalized
rows. The startup log reports the number released so operators can distinguish
automatic terminal cleanup from targeted Answer rebuilds and rollbacks.

## Contract changes

`StaleOutboxQuarantineRecovery` gains `terminalizedQuarantines: number`. All
callers and tests use the expanded result. `OutboxQuarantineAction` gains
`startup_terminalized`. No database schema migration is required because the
action column is unconstrained text.

## Verification

Add store tests that reproduce a terminal failed Answer stream with no pending
successor and assert that startup recovery releases only its quarantine while
retaining the dead letter. Add negative cases for a running prompt and for a
terminal prompt whose lane still contains pending work. Update startup workflow
tests for the expanded recovery result.

Run focused SQLite/startup/health tests, TypeScript checks, the full suite, and
the production build. After installation and restart, `/status` must report
`ok`, `outboxQuarantines.active` must be zero, and historical dead-letter counts
must remain present.
