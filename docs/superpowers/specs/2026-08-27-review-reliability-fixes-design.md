# Review Reliability Fixes Design

## Goal

Resolve the three reliability issues found in the repository-wide review:

1. converge an existing streaming Answer Card when its Herdr pane becomes orphaned;
2. allow a dead-lettered final folded-card update to converge again;
3. bound and cache TraeX transcript discovery.

The changes must preserve durable-before-delivery behavior, prompt non-replay,
per-Answer ordering, and canonical Answer source offsets.

## Orphaned Answer convergence

`SqliteBindingStore.orphanBindingWithProjection` remains the atomic authority for
changing the binding, affected prompts, run-card projections, TopicView, and
immediately derivable outbox intents. It returns the IDs of every run card moved
to `failed`.

After that transaction commits, `HerdrRuntimeReconciler` asks an injected
prompt-view convergence port to converge each returned prompt ID. Existing
CardKit Answer pages then use the normal `AnswerPageWorkflow` state machine to
persist the failed content and finish intent. Cards that have not yet become
CardKit entities continue to use the intents created inside the orphan
transaction.

The post-commit wake-up is an acceleration path, not the only recovery path.
`StartupViewConverger` continues to converge every persisted run card after a
restart. Therefore a crash between the orphan transaction and the in-process
wake-up cannot lose the terminal state or replay the TraeX prompt.

## Final folded-card dead-letter recovery

The final folded-card update remains a replaceable `card_update` with one stable
idempotency key per prompt, page, and CardKit card. Reserving it becomes
state-aware:

- a pending intent means delivery is already waiting;
- a delivered intent means the desired final rendering is current;
- a dead-lettered or dismissed intent is reopened as pending, with retry fields
  reset and the latest payload and view version stored;
- no existing intent creates the initial pending row.

Reopening the same row preserves lane ordering and Lark idempotency while
avoiding an unbounded series of recovery keys. The normal outbox notifier wakes
delivery after the reservation reports `reserved`. A permanently invalid target
may fail again and remain visible through the existing failure controls.

## Bounded TraeX transcript lookup

`TraexTranscriptReader` owns a per-instance cache from validated session ID to
canonical transcript path. A cache hit revalidates that the path still resolves
inside the configured sessions root and still contains the matching
`session_meta` identity before opening a cursor. Invalid entries are evicted and
fall back to discovery.

Discovery uses a shared traversal budget and a global stop signal. It stops as
soon as two matching filenames are found, because the result is already
ambiguous. It also stops after a fixed maximum number of directory entries;
exhausting that budget returns terminal mode with a bounded lookup reason rather
than delaying prompt dispatch indefinitely. Successful unique matches are
cached.

The cache is deliberately in-memory. Persisting filesystem paths in SQLite would
create stale cross-host state and is unnecessary because a process restart can
perform one bounded rediscovery.

## Interfaces and boundaries

- `HerdrRuntimeReconciler` receives a narrow `convergeAnswer(promptId)` callback
  or equivalent port; it does not render or reserve stream operations itself.
- `AnswerPageWorkflow` remains the owner of Answer page planning.
- `SqliteBindingStore` remains the owner of outbox state transitions and exposes
  state-aware final-card reservation through the existing port method.
- `TraexTranscriptReader.open()` remains the public transcript lookup seam; cache
  and traversal details remain private.

No schema migration or new background worker is required.

## Error handling

- Failure to converge one orphaned prompt is logged with binding and prompt IDs;
  it does not roll back the already committed orphan transition or prevent other
  affected prompts from converging.
- A transcript cache validation or directory traversal error returns the existing
  terminal fallback mode. No prompt is rejected solely because typed output is
  unavailable.
- Reopened final-card intents use the existing retry, dead-letter, quarantine,
  and operator recovery behavior.

## Tests

Tests exercise public seams and durable outcomes:

1. A reconciler integration test starts with an active CardKit Answer page,
   removes the pane, and verifies that the run card becomes failed and the
   Answer page receives terminal delivery work without restarting the bridge.
2. An Answer-page/store test dead-letters a final folded update, reconverges the
   completed run, and verifies that the same intent is reopened instead of a new
   duplicate being inserted.
3. Transcript-reader tests verify cache reuse, invalid-cache eviction, immediate
   global stop after ambiguity, and terminal fallback when the traversal budget
   is exhausted.

Affected tests, TypeScript typechecking, the production build, and the complete
Vitest suite must pass before handoff.
