# Terminal Binding Detached Prompt Convergence Design

## Problem

`scanDurablePromptWork()` cancels queued work owned by a binding that can no
longer dispatch, but it leaves `running` ordinary prompts in detached
observation forever. When such a binding is archived, closed, failed, or
orphaned, no observer can be scheduled and no future reconciliation can settle
the prompt. These rows keep the operational running count non-zero and block a
normal service restart even though no TraeX turn or bridge worker is active.

This is a durable-state convergence defect. It must not be addressed by deleting
history, weakening the restart guard, replaying a prompt, or deriving workflow
state from Lark.

## Decision

The durable work scan will terminalize detached ordinary prompts whose owning
binding is terminal. The existing terminal-binding predicate remains the shared
definition for queued cancellation and detached convergence:

- legacy binding state is `archived`, `orphaned`, or `failed`; or
- lifecycle is `archived`, `closed`, or `failed`; or
- attachment is `orphaned`.

For each matching prompt whose state is `running`, dispatch kind is `turn`, and
observation state is `detached`, one SQLite transaction will apply both durable
transitions:

- prompt state becomes `failed`;
- observation state becomes `completed`;
- `was_detached` remains true;
- error becomes `Session ended while a dispatched turn was detached; the prompt was not replayed`;
- matching Run Card phase becomes `failed`;
- Run Card notice uses the same text, queue position becomes zero, and
  `finished_at`, `activity_at`, and `updated_at` use the scan timestamp; and
- Run Card view version advances once.

The scan result gains a `failedDetached` count. `cancelled` continues to mean
only queued prompts cancelled before dispatch, so existing operational meaning
is not overloaded. Wake-up hints remain identity-only and are computed after
terminalization.

## Safety Boundaries

The transition records uncertainty rather than claiming that TraeX failed. The
prompt may have reached TraeX, so it is never returned to the queue and never
replayed. Audit rows and detached provenance are retained.

Detached turns on active, attached bindings are unchanged and continue to
produce `detached-observer-ready` hints. Attached running turns are outside this
repair because their worker may still be active. Steering work keeps its
existing recovery rules. Missing Run Cards do not prevent prompt convergence;
when a card exists, the prompt and card updates occur in the same transaction.
Repeated scans are idempotent because only `running` plus `detached` rows match.

The restart safety guard remains unchanged. Once convergence has run, it sees
the corrected durable count rather than being taught to ignore running rows.

## Startup and Rollout

Startup already invokes durable work recovery and scanning before workers are
woken. No new migration or background service is required. The first startup of
the new build terminalizes historical matching rows.

The currently running old build cannot execute the new convergence rule and its
restart guard is blocked by the stale rows. Deployment therefore requires one
explicitly authorized forced restart. After the new process starts, verification
must establish all of the following:

1. `/ready` reports ready and the deployed build identity matches the commit.
2. The six known stale detached prompts are `failed/completed` and retain
   `was_detached=1`.
3. Their Run Cards are failed with a finished timestamp and the no-replay notice.
4. Operational running prompt count is zero, with no active turn workers and no
   pending outbox work.
5. A subsequent dry-run or normal restart guard no longer rejects solely because
   of those rows.

## Tests

The SQLite store regression test constructs terminal bindings through each
independent predicate: archived lifecycle/state, closed lifecycle, failed
lifecycle/state, and orphaned attachment/state. Each owns a detached running
turn and a Run Card. One active and attached binding supplies the negative
control.

Assertions cover prompt and Run Card fields, the `failedDetached` count, no
wake-up hint for terminalized work, an observer hint for the active control,
idempotence on a second scan, and absence of prompt body/message identity in the
scan result. Existing queued-cancellation tests continue to prove that queued
work uses the separate `cancelled` count.

Before deployment, run the focused SQLite tests, TypeScript typecheck, the full
Vitest suite, the production build, and `git diff --check`.
