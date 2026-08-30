# Detached Turn Identity Fence Design

## Problem

Detached prompt recovery currently correlates a TraeX transcript turn with a
Lark prompt using only a lower time bound: the transcript turn must start no
earlier than the Run Card's `started_at`, with a one-second tolerance. The
prompt does not durably retain the TraeX `turn_id` that accepted its text.

That fence is insufficient when a person continues using the same Herdr pane.
A later manual TraeX turn also satisfies the lower bound. Worse, the detached
observer publishes answer and tool deltas before it evaluates the completion
fence, so unrelated manual output can be appended to the old Lark Answer Card.
The prompt can then remain operationally `running` forever or complete with the
wrong turn's output, blocking a normal service restart and violating prompt
provenance.

The live failure has both forms. One detached Run Card starts just after the
only plausible completed turn and can never settle. Another detached prompt is
currently consuming later manual turns from the same pane. Herdr `idle` is not
completion authority, and neither row can be repaired by replaying its prompt.

## Decision

Bind every newly dispatched ordinary prompt to one exact TraeX turn and persist
that ownership before publishing turn output. Time remains an admission check
for the first ownership claim; it is not completion identity.

`prompt_jobs` gains nullable durable provenance fields:

- `dispatched_at`: the bridge time at which Herdr confirms that prompt input was
  submitted;
- `transcript_turn_id`: the exact UUID from the accepted `task_started`; and
- `transcript_turn_started_at`: the canonical start time carried by that
  `task_started`.

`markPromptDispatched` records `observation_state = 'attached'` and
`dispatched_at` in the same SQLite statement. A new compare-and-set store
operation claims transcript ownership only when all of these facts remain true:

1. the prompt is the expected `running` ordinary prompt for the binding;
2. its observation state is `attached`;
3. it has not previously been detached;
4. `dispatched_at` exists;
5. the observed lifecycle is `task_started`; and
6. its canonical start is within the small existing clock tolerance of, or
   later than, `dispatched_at`.

The first successful claim wins. A different later `turn_id` can never replace
it. Repeated observation of the same ID is idempotent. A conflicting ID is
ignored and recorded only as a bounded diagnostic without prompt text, answer
content, transcript path, or credentials.

## Observation and projection

Attached and detached observation share one ownership gate before any
`TurnOutputObserved` publication:

- Before ownership is claimed, answer deltas, tool activity, plan/status data,
  token data, and lifecycle completion are not projected.
- After ownership is claimed, only observations belonging to the persisted
  `transcript_turn_id` may update the cards or complete the prompt.
- A matching `task_complete` is the only detached completion authority. Herdr
  `idle`, composer readiness, terminal content, and a later transcript turn do
  not settle the prompt.
- Output accumulated before the claim may be released only when it came from
  the same claimed lifecycle. Output from the transcript baseline or a
  conflicting lifecycle is discarded for this prompt.

The transcript reader therefore exposes lifecycle identity together with each
typed observation, and the workflow owns correlation. Card reducers, CardKit
pagination, and the durable outbox remain unchanged.

Normal attached completion still waits for the Herdr prompt operation to
settle, but its Answer content is restricted to the owned transcript turn. If
structured ownership cannot be established, the existing fixed
structured-output-unavailable notice is used instead of unrelated transcript
content. The prompt is never failed merely because structured output is
unavailable.

## Restart and legacy recovery

Restart recovery preserves `dispatched_at`, `transcript_turn_id`, and
`transcript_turn_started_at` while changing an attached running prompt to
detached. The detached observer can resume only an exact persisted turn.

A running prompt that was already detached without `transcript_turn_id` is
legacy uncertain state. It remains visible and blocks the normal restart safety
gate, but the observer must not open-endedly attach it to the latest or next
transcript turn. No timestamp heuristic, answer text, Lark state, pane idle
state, or operator activity is used to invent provenance. It is never replayed.
An operator must explicitly resolve such a row through the existing lifecycle
or an independently approved repair procedure. This release does not silently
fail, cancel, migrate, or rewrite those live rows.

If the binding becomes terminal, the existing durable convergence rule still
marks its detached prompt failed with the no-replay notice. Queued work remains
queued until its binding can dispatch normally or becomes terminal.

## Schema and compatibility

The SQLite migration adds the three nullable columns without rewriting existing
rows. The prompt row mapper and domain type expose them as nullable values. The
new compare-and-set operation is transactional and returns whether ownership was
claimed, already matched, or conflicted, allowing the workflow to distinguish
safe idempotence from rejection.

No changes are made to Lark command syntax, Herdr pane identity, binding
generation, Worker behavior, service identity, or private log paths. No live
database is copied or directly edited as part of implementation or tests.

## Diagnostics

Structured logs add bounded ownership events containing only `bindingId`,
`promptId`, `paneId`, the accepted or observed turn ID, and an outcome:

- `transcript-turn-owned`;
- `transcript-turn-conflict`; or
- `detached-turn-identity-missing`.

Missing legacy identity is reported as an uncertain observation rather than a
loop that continuously streams unrelated output. Operational prompt counts and
the restart safety guard remain truthful and unchanged.

## Verification

Focused tests must prove all of the following:

1. dispatch persists its timestamp and the first eligible `task_started` claims
   exact ownership atomically;
2. a baseline lifecycle from before dispatch cannot be claimed;
3. output is not projected before ownership;
4. output and completion for the owned turn are projected once, including after
   restart, without a second Herdr prompt submission;
5. a later manual turn on the same pane cannot append to or complete the old
   prompt;
6. a legacy detached prompt with no turn ID remains uncertain and does not
   consume new transcript output;
7. a conflicting compare-and-set cannot replace persisted ownership;
8. FIFO dispatch resumes only after the exactly owned turn completes; and
9. migration and restart recovery preserve provenance fields.

Before deployment, run the affected transcript, SQLite, prompt lifecycle, and
concurrency tests, then the full Vitest suite, TypeScript typecheck, production
build, and `git diff --check`. Deployment remains blocked until the two current
legacy detached prompts receive an explicit operator decision; `--force`,
prompt cancellation, and live SQLite mutation are outside this design.
