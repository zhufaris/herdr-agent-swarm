# Orphaned Prompt Claim Recovery Design

## Problem

An ordinary prompt can be durably claimed as `running/not_started` before the
Herdr adapter confirms that submission may have reached TraeX. If the owning
workflow disappears without making a later durable transition, that row blocks
the binding FIFO indefinitely:

```text
queued -> running/not_started -> no live owner
                              -> later queued work remains blocked
```

Startup recovery already requeues ordinary non-model claims that have no
dispatch evidence. The periodic durable-work scan does not apply an equivalent
rule: it discovers queued turns and detached observers, while every `running`
row suppresses the queued-turn wake-up. Consequently, a live service cannot
repair an orphaned pre-dispatch claim without a restart.

The observed `e8g2` incident had exactly this shape. Prompt
`c913603a-af99-4b05-abac-325d7aea742c` remained `running/not_started` with no
transcript identity while its pane was idle, preventing later FIFO work from
dispatching.

## Safety invariant

The bridge must never replay a prompt that may have reached TraeX. Absence of a
transcript turn is not sufficient proof that delivery did not occur. Online
recovery may requeue a claimed prompt only when all of these facts hold:

1. the prompt is still `running/not_started`;
2. `dispatched_at` and `transcript_turn_id` are both null;
3. no model-prompt prepare or acceptance fence exists;
4. the current process has no live worker or `TurnSupervisor` ownership for the
   binding; and
5. the claim is older than a bounded grace period.

The in-memory ownership check is essential. SQLite cannot distinguish an
orphaned claim from a live worker blocked between claim and its dispatch
callback. Conversely, in-memory state alone cannot authorize a write; the store
must recheck every durable predicate in the same transaction that requeues the
prompt.

Any dispatch evidence makes the prompt ineligible for replay. Such prompts
remain attached or detached and follow the existing exact-transcript recovery
rules.

## Design

### 1. Make pre-dispatch settlement explicit

`PromptRunWorkflow` will centralize settlement of a claimed prompt that exits
before dispatch confirmation. Every exit from the claim scope must produce one
of these durable outcomes:

- confirmed or possibly dispatched: `running/attached`, later detached if the
  observer fails;
- proven not dispatched: failed for an ordinary execution error, or safely
  requeued during controlled recovery;
- completed, failed, or cancelled terminal state.

Binding-inactive and shutdown branches must not silently leave the row in
`running/not_started`. Before returning, they invoke a store transition fenced
by the exact prompt and binding generation. If the adapter has reported possible
dispatch, the transition is detach-only.

### 2. Discover candidates without mutating them

The durable safety scan will return a bounded list of stale pre-dispatch claim
candidates in addition to its existing wake-up hints. Candidate discovery uses
only durable facts and does not itself requeue anything. This keeps the store
from guessing whether the current process still owns a waiter.

The candidate query requires `running/not_started`, null dispatch and transcript
identity, no prepared model operation, and an `updated_at` older than the grace
cutoff. Results are bounded and ordered by creation time.

### 3. Requeue only unowned candidates

For each candidate, `PromptRunWorkflow` checks both worker ownership and
`TurnSupervisor` ownership for its binding. Owned candidates remain unchanged.
For an unowned candidate it calls an atomic store operation that repeats all
candidate predicates and changes the prompt back to `queued/not_started`. The
operation also restores its Run Card to queued state and clears stale start
presentation.

After a successful compare-and-set, the workflow emits a `prompt-ready` hint for
the binding. The normal FIFO claim path then processes it. A failed compare-and-
set means state changed concurrently and is treated as a harmless no-op.

The grace period prevents a scan from racing the short interval between the
SQLite claim and registration of workflow ownership. It should be configurable
through the workflow constructor for deterministic tests and default to at
least two safety-scan intervals in production.

### 4. Preserve model dispatch fencing

A model-aware claim is safe to requeue only before `onPrepared` persists an
operation ID. Requeueing also atomically restores its matching model preference
from `applying` to `pending` and clears the prompt's pinned model fields. If a
prepared operation exists, the prompt is delivery-uncertain and cannot be
replayed.

The existing startup recovery behavior remains the semantic reference. The new
online path uses the same durable predicates rather than introducing a broader
definition of “not started.”

## Failure handling and observability

A successful online recovery logs one bounded event containing prompt and
binding identifiers, age, and outcome `requeued_before_dispatch`. It does not log
prompt text. Safety-scan diagnostics add a recovered-claim count but do not
retain candidate identities in the health snapshot.

If candidate discovery or compare-and-set fails, the scan retains its existing
retry cadence. The prompt remains unchanged; no speculative fallback or replay
is attempted.

## Tests

Store tests will prove that:

- an old ordinary `running/not_started` prompt with no evidence can be requeued;
- a recent claim is not returned as stale;
- `dispatched_at`, transcript ownership, or a prepared model operation prevents
  requeue;
- the prompt and Run Card transition atomically; and
- successful recovery unblocks the next FIFO claim.

Workflow tests will reproduce the incident shape: an old durable claim exists,
the pane binding is active, but no worker or supervised turn owns it. A safety
scan requeues and wakes it. The paired test keeps an active in-memory owner and
asserts that the same durable candidate is not changed.

## Non-goals

- Inferring completion from an idle pane.
- Replaying identity-less detached prompts.
- Repairing SQLite from Lark card state.
- Changing Herdr prompt or transcript-settlement semantics.
- Recovering legacy rows that contain contradictory dispatch evidence.
