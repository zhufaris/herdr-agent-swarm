# Detached Answer Streaming Design

## Problem

Herdr can return `agent_prompt_stalled` when a prompt reached TraeX but the
terminal state did not visibly transition within the command's five-second
acceptance window. The bridge correctly treats this as an uncertain dispatch:
it marks the prompt detached and never replays it.

The detached observer currently reads the identified TraeX JSONL transcript but
uses it only to detect `task_complete`. It discards answer and status deltas
while the turn is active. The Answer card is therefore created but remains empty
until final completion, even though the Herdr terminal and JSONL are progressing.

## Decision

Keep the uncertain-dispatch and no-replay behavior unchanged. Extend detached
observation so every typed transcript read publishes the same
`TurnOutputObserved` projection used by the normal attached observer. This keeps
the Answer card live while Herdr's command waiter is detached.

A small private helper will own the shared delta-to-event projection. It will:

- retain answer chunks in the existing transcript source;
- publish only when an answer delta or main-status update exists;
- compute elapsed time from the durable run-card start time;
- leave CardKit rendering, pagination, sequencing, and outbox delivery in the
  existing projector and publisher;
- preserve the final `task_complete` identity/time fence before completing a
  detached prompt.

No prompt text is resent, no terminal input fallback is added, and no Lark card
or SQLite row is edited outside the existing event/projection paths.

## Recovery and completion

The detached observer opens the exact persisted TraeX session transcript at its
current end, then observes subsequent records. New answer/status records are
projected immediately. When a matching `task_complete` arrives, the workflow
uses its canonical final answer (or accumulated typed chunks), durably completes
the prompt, and emits `TurnCompleted`.

This change fixes live updates after a mid-turn `agent_prompt_stalled`. It does
not reconstruct transcript text written before the detached observer opened;
the final completion payload remains the authoritative recovery mechanism for
that earlier output.

## Verification

Add an integration regression covering a prompt that is already marked
`running/detached`: the fake transcript emits an answer delta before completion,
the run card must update while the prompt remains running, and a later matching
completion must finish the prompt without any second Herdr prompt submission.
Run the focused prompt/concurrency tests, TypeScript typecheck, and production
build before restarting the live service. Restart only after the current prompt
and outbox are drained.
