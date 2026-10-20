# Feishu Native Input Batching

## Problem Statement

The current Primary Prompt path durably accepts each ordinary Feishu message as
one `PromptJob`, creates one Run/Answer projection immediately, and leaves later
ordinary Prompts in SQLite while the bound Herdr pane is `working` or `blocked`.
`PrimaryPromptDispatcher` rejects those runtime states as `runtime_busy`, and the
existing concurrency integration test explicitly proves that `queuePrompt` is
not called until the active turn settles.

Live diagnosis for Pane token `ri13` showed that recent Feishu messages were not
lost at ingress: they were accepted and persisted as `queued/not_started` work.
The Primary Main projection was also current at the observed checkpoint. The
reported behavior is therefore a mismatch between the desired Herdr native
input-queue semantics and the current strict SQLite-only FIFO policy, not an
inbound-message or Lark-delivery loss.

The intended behavior is to feed later ordinary Feishu work into Herdr's native
queue while a turn is active. Messages must first be durably collected for two
seconds, drained in FIFO batches of at most three, combined into one native
submission, and represented by one shared Run/Answer Card. Original Feishu
message identities must remain durable for audit and idempotency. A submission
that may have crossed the Herdr/Core boundary must never be replayed
automatically.

## Solution

Add a SQLite-owned **Native Input Batch** aggregate in Prompt Execution. Each
eligible Feishu message is admitted as a durable **Prompt Input** with its own
source identity. When no ordinary turn is active, the first input forms a
single-member batch immediately, preserving the current low-latency behavior.
When a turn is active, the first input opens a durable two-second collection
window. At the deadline, one transaction selects at most three unassigned
inputs in FIFO order, freezes their combined text, and creates the batch's one
ordinary execution Prompt, Run projection, Answer delivery intent, and native
submission intent.

The Native Input Batch and its execution Prompt share one business identifier.
That identifier remains the authoritative native submission ID and downstream
Prompt ID, so the existing exact Core observation, detached recovery, Answer
pagination, model-selection and outbox paths continue to operate on one
execution owner. Prompt Inputs are immutable source members, not independent
execution owners, and therefore do not create individual Run/Answer Cards.

After Herdr confirms a batch submission, later due batches may be submitted in
FIFO order even while the pane remains `working` or `blocked`. Submission calls
remain serialized per binding. Herdr/Core serializes the resulting turns. A
confirmed pre-effect rejection may retry the same durable batch; an uncertain
effect becomes detached observation and is never automatically replayed.

The Primary Main projection is invalidated by durable input-window, batch and
native-queue transitions. It reports source-message backlog separately from
formed/native-queued batch work, rather than treating a visually stale card as
workflow truth.

Only normal ordinary Feishu text input uses this batching policy. Explicit
steering, priority/control work, card continuations, internal Prompts, native
Herdr turns and Worker queues retain their current contracts. Installation,
restart and deployment remain separately authorized operations.

## User Stories

### SCN-1: Idle Primary receives ordinary Feishu input

As a Feishu user, when the exact bound Primary is settled and no batch window or
earlier executable work exists, my message is durably admitted and immediately
formed as a one-member Native Input Batch. It receives one Run/Answer Card and
is dispatched without the two-second delay.

### SCN-2: Active Primary collects a batch

As a Feishu user, when the exact bound Primary is `working` or `blocked`, my
first eligible message opens a durable two-second window. Up to two later
eligible messages for the same binding join the eventual drain in source FIFO
order. At the deadline, the batch is submitted once as one combined native
request and has one shared Run/Answer Card.

### SCN-3: More than three messages arrive

As a Feishu user, when more than three eligible messages are waiting, the first
drain claims only the earliest three. Remaining inputs stay unassigned in FIFO
order. The next head opens a new two-second window after the prior drain forms;
it is not appended to the frozen batch and does not bypass the per-drain limit.

### SCN-4: Duplicate source delivery

As the inbound pipeline, when the same Feishu message is delivered again, the
existing `(ingress source, source message key)` member is returned. It is never
inserted into a second batch, never changes batch order, and never creates a
second card or native submission.

### SCN-5: Process restart during collection

As an operator, when the service restarts before a collection deadline, SQLite
retains the window and unassigned inputs. Recovery waits for the remaining time
or immediately drains an expired window. Process-local wake-ups and timers are
only hints and cannot change membership or ordering.

### SCN-6: Native submission outcome is known or uncertain

As an operator, a confirmed `not_started` or rejected native call leaves the
same frozen batch eligible for a later submission attempt. If the call times
out, disconnects, returns mismatched identity, or otherwise may have reached
Herdr/Core, its execution Prompt becomes detached/uncertain and is observed
without replay. Member inputs never return to the unassigned FIFO.

### SCN-7: Identity changes before submission

As an operator, when the binding generation, pane or exact Agent session no
longer matches the batch fence, the batch is not submitted to the new runtime.
Normal binding recovery or terminalization owns the outcome; the coordinator
must not weaken the fence or move members to another generation implicitly.

### SCN-8: Main and Answer projections converge independently

As a Feishu user, I see one Run/Answer Card per formed batch and no per-member
cards. The Primary Main Card reflects collection backlog and native-queued batch
work through normal event/reducer/outbox convergence. Lark retry or redelivery
does not repeat the native submission.

### SCN-9: Steering and non-Feishu work remain separate

As a Feishu user, explicit eligible steering still targets the exact active
turn through its existing path. Priority work, card continuations, internal
Prompts and direct Herdr work do not join a Native Input Batch and retain their
current admission and projection behavior.

## Implementation Decisions

### Domain Model

The primary affected bounded context is **Prompt Execution**, which owns Prompt
Input admission, collection windows, batch membership, frozen submission text,
FIFO formation and dispatch evidence. **Primary Session** supplies the current
Binding Generation, Runtime Pane Reference and exact Agent session fence.
**Conversation Projection** derives one Run/Answer projection per formed batch
and the updated Topic Projection. **Delivery and Operations** persists and
publishes the resulting delivery intents without owning batch execution.

The proposed canonical terms are:

- **Prompt Input**: one authorized ordinary Feishu source message durably
  accepted for possible batch formation. Its source identity, actor, body,
  binding generation and arrival order are immutable. It is not independently
  dispatchable and does not own a Run Projection.
- **Collection Window**: the durable two-second interval opened for one binding
  after the first eligible input while an ordinary turn is active. A deadline,
  not an in-memory timer, determines eligibility to drain.
- **Native Input Batch**: the aggregate root that owns one frozen ordered set of
  one to three Prompt Inputs and exactly one execution Prompt/native
  submission. Its ID is also the execution Prompt ID and submission ID.
- **Batch Member**: a Prompt Input assigned once to a Native Input Batch with an
  immutable zero- or one-based ordinal. Source identity and membership are not
  inferred from combined text.
- **Native-Queued Batch**: a formed batch whose native submission may have
  crossed the Herdr/Core boundary and therefore can only advance through exact
  observation or detached recovery.

`PromptJob` remains the downstream execution lifecycle entity, but for batched
Feishu work it is created only when the Native Input Batch is formed. The
batch's ID, `PromptJob.id`, native submission ID, Core request submission ID and
Run Projection owner ID are equal. This preserves the existing exact ownership
contract while avoiding a first-member/leader special case. Existing ordinary
Prompts created before this migration remain valid single execution owners.

The batch is the aggregate root for formation. Its atomic consistency boundary
contains the collection state, selected members, frozen combined body, the one
execution Prompt and initial Run/Answer projection intent. Later execution
transitions continue through the existing Prompt lifecycle stores, fenced by
the one-to-one batch/Prompt identity. Repositories load a batch with ordered
members and save state transitions conditionally; callers cannot mutate
membership or reconstruct a batch by writing individual rows.

#### INV-1: A source message is admitted and assigned at most once

Prompt Input source identity is unique. A member has at most one batch and one
ordinal. Duplicate ingress returns the existing durable result and emits no new
workflow or delivery effect.

#### INV-2: A drain is FIFO, bounded and immutable

A due drain selects the earliest eligible unassigned inputs for one binding and
generation, up to three. Selection, membership, combined text and batch
formation commit atomically. Once formed, neither order, body nor membership can
change.

#### INV-3: One batch owns one execution and one visible run

Every formed Native Input Batch has exactly one execution Prompt, submission
identity and Run/Answer projection. Prompt Inputs never own execution state or
individual Run/Answer Cards.

#### INV-4: Per-binding submission order is serialized

Only the oldest formed, not-yet-submitted batch may make a native submission
call. One call is in flight per binding. A later batch cannot overtake a
collecting, formed or call-in-flight predecessor, although multiple confirmed
native submissions may wait inside Herdr/Core.

For this path, the existing **Execution Slot** language is refined into two
separate rights: one **Native Submission Slot** serializes external queue calls,
while one **Active Turn Slot** identifies the exact Core turn currently
producing output. A confirmed native-queued future batch occupies neither a new
submission call nor the active turn until exact Core evidence adopts it. This
separation permits several accepted future batches without permitting parallel
turn ownership or text/position-based adoption.

#### INV-5: Possible native delivery is never replayed

Only an effect classified as `not_started` or rejected may retry the same
frozen batch. Any effect that may have crossed the boundary is persisted before
observation continues and can never return its members or execution Prompt to
an automatically replayable state.

#### INV-6: Runtime identity is generation- and session-fenced

Formation and submission require the current binding generation. Native
submission additionally requires the exact pane and Agent session identity.
`working` and `blocked` permit native queue submission only with those exact
fences; `unknown`, missing pane, changed workspace or changed identity do not.

#### INV-7: Backpressure counts source work

`MAX_QUEUE_DEPTH` counts each accepted, nonterminal Prompt Input plus legacy
queued ordinary Prompts, not merely the number of formed batches. Batching must
not allow nine source messages to consume only three queue slots. For ordinary
Feishu input, exhaustion of this accepted-source limit is now an upstream
durable capacity deferral rather than terminal rejection; see
`2026-10-02-feishu-capacity-deferral.md`.

#### INV-8: Presentation cannot drive execution

Run/Main delivery may retry, dead-letter or be redelivered independently. No
Lark outcome changes batch membership, submission eligibility or no-replay
state.

### Architecture

#### ARCH-1: Admission persists input before projection

`BindingPromptWorkflow` routes eligible ordinary Feishu text to a domain-owned
batch-admission port. The SQLite adapter atomically deduplicates the Prompt
Input, applies source-message backpressure and creates or reuses the applicable
collection window. Admission does not create a per-input Run projection.
Existing durable `inbound_messages` acceptance remains upstream evidence but is
not reused as mutable batch state.

An admission receipt can therefore represent either an input still collecting
or a batch already formed by an idempotent duplicate. Effects wake batch work
and Main projection convergence; Answer delivery is reserved only at formation.

#### ARCH-2: SQLite owns due-window drain

Extend the domain-owned Prompt Execution store with operations equivalent to:

- admit one Prompt Input with binding-generation and queue-depth fences;
- atomically form the next due batch with at most three FIFO members;
- load the oldest formed batch eligible for native submission;
- persist confirmed, rejected or uncertain native submission evidence;
- scan durable windows/batches after restart and return wake hints.

The concrete schema uses additive durable records for Prompt Inputs, Native
Input Batches and ordered membership. The batch ID is created when the window
opens and reused for the execution Prompt at formation. Required uniqueness and
foreign-key constraints enforce INV-1 through INV-3. These application tables
must participate in the existing instance-lease fence.

#### ARCH-3: Coordinator schedules deadlines without owning them

The prompt worker gains a per-binding batch drain path. It may use an abortable
timer for the nearest deadline, but every wake reloads SQLite and only the store
decides whether a window is due. Startup recovery and periodic durable scans
wake expired windows, so timer loss is harmless. After forming a capped batch,
the store opens the next two-second window for any remaining FIFO head.

#### ARCH-4: Dispatcher submits formed batches through the existing adapter

`PrimaryPromptDispatcher` stops claiming raw member messages. It claims the
oldest formed execution Prompt/batch and calls the existing Herdr adapter with
the frozen combined body and shared batch ID. The dispatcher permits exact
`working` or `blocked` runtime for this native-queue path, while preserving the
current settled bootstrap path when no native session exists. Submission calls
are serialized and return after durable receipt/uncertainty persistence so the
next batch can be considered without waiting for the prior turn to finish.

Pending model preference remains binding-scoped and is pinned once to the
formed execution Prompt by the existing model-dispatch contract. It applies to
the whole combined batch, never to individual members. Model queue capability
and failure fences remain fail-closed.

#### ARCH-5: Combined text is a frozen boundary value

The batch formatter is deterministic and bounded. For `N` members it emits, in
member ordinal order:

```text
[Feishu message 1/N]
<first body>

[Feishu message 2/N]
<second body>
```

Internal Prompt/Input IDs and Feishu message IDs are not exposed to the Agent.
The exact formatted text is persisted at formation and is the only body passed
to `queuePrompt`; recovery never regenerates it under newer formatting code.
Existing input validation/redaction boundaries remain in force.

#### ARCH-6: Core observation remains Prompt-owned

Once formed, existing Core-event adoption and observation use the batch's
execution Prompt ID without parsing text or guessing queue position. Exact
submission identity claims the corresponding turn. Accepted-but-not-yet-run
batches may coexist as detached/native-queued Prompts, and their FIFO submission
order does not substitute for exact turn ownership.

#### ARCH-7: Projection and delivery derive from durable transitions

Formation creates one queued Run Projection and one Answer-card create intent.
Prompt lifecycle events update it through existing reducers. Collection,
formation and native-queue transitions also invalidate the Topic Projection so
the Main Card can show unbatched source-message count and formed/native-queued
batch count. Coordinator code never calls Lark directly. Existing outbox
idempotency remains keyed by the shared execution Prompt ID and view version.

Source dependencies remain inward through domain-owned ports: coordinators use
Prompt Execution and presentation contracts; SQLite, Herdr and Lark adapters
implement them; composition assembles concrete dependencies. No SQLite row,
Herdr response or Lark SDK type enters domain policy.

### Behavior & Failure Modes

- Idle admission forms a one-member batch immediately. Once an active-turn
  window exists, a transition to idle does not dissolve it or bypass its
  deadline.
- At an active-turn deadline, zero eligible inputs is an idempotent no-op. One
  to three inputs form exactly one batch. Remaining inputs receive a new window
  beginning after that drain.
- A crash before formation leaves inputs unassigned and safely drainable. A
  crash after the formation transaction finds the same frozen batch, execution
  Prompt, card intent and submission identity.
- A crash before a native call can retry the same formed batch. The dispatcher
  must persist a call-attempt fence before invoking the adapter so restart can
  distinguish definitely-not-started from possibly-started work.
- A confirmed pre-effect rejection retains the same batch, body, members and
  submission ID for a bounded later attempt. It does not dissolve the batch.
- Timeout, disconnect, receipt mismatch, stale durable receipt fence or any
  other possibly-started outcome enters detached/uncertain observation and
  cannot replay.
- A generation, pane, workspace or session mismatch prevents submission. No
  member is reassigned to a replacement binding generation automatically.
- Duplicate wake hints, deadline timers and startup scans are harmless because
  conditional SQLite transitions choose one winner.
- Main/Answer outbox failure retries only presentation. Card redelivery never
  causes another batch formation or native submission.
- Steering classification happens before batch admission. A message cannot be
  both a batch member and Steering Work.

### Compatibility & Migration

Additive schema migration creates the input, batch and membership records and
their FIFO, uniqueness and recovery indexes. It also adds every new
application table to the instance-lease fence. The migration does not rewrite
historical Prompt, Run, Answer or outbox rows.

Existing queued ordinary Prompts at deployment remain legacy single-message
execution Prompts and continue through their current cards and no-replay
recovery. Only newly admitted eligible Feishu ordinary input uses Prompt Input
batching. This avoids inventing membership or combined text for historical
rows.

The Prompt Execution context documentation must replace the single-slot
assumption for this native batching path with the approved Native Submission
Slot and Active Turn Slot distinction. Operational counts and restart safety
must count collecting inputs, formed batches, native-queued batches and the
exact active turn without treating future native-queued batches as concurrent
running turns.

The Prompt Execution glossary and Primary Session Prompt-ID definition must be
updated: for new batched Feishu work, the execution Prompt identifies the
combined Native Input Batch, while each source Feishu identity belongs to a
Prompt Input member. The equality
`batch_id == prompt_id == native_submission_id == Core submission_id` remains
mandatory. Existing non-batched Prompt IDs retain their current meaning.

Existing explicit steering, priority/control admission, card continuation,
model selection, direct Herdr turn adoption, Answer pagination, detached
recovery and `/swarm awake` redelivery contracts remain compatible.

## Testing Decisions

- Store tests verify Prompt Input source dedupe, immutable body/actor/source
  identity, one-batch membership, FIFO ordinal assignment, the three-member
  limit, source-count backpressure and instance-lease fencing.
- Store round-trip tests form a batch, reopen SQLite, and verify deadline,
  ordered members, exact frozen body, batch/execution identity, state and
  submission evidence. Reopening must not produce another batch or card intent.
- Fake-time workflow tests verify immediate idle formation; active windows with
  one, two and three messages; four and seven messages producing capped later
  windows; no early drain; and expired-window recovery after restart.
- Concurrency integration tests race duplicate admissions, competing drainers
  and multiple wake hints. Exactly one transaction owns each input and batch,
  and cross-binding windows progress independently.
- Dispatcher tests verify exact `working` and `blocked` native-queue submission,
  refusal for unknown/mismatched identity, per-binding call serialization,
  oldest-batch order, deterministic combined text, and unchanged bootstrap
  behavior for a settled pane without a native session.
- Failure tests distinguish confirmed rejection from uncertain delivery. Only
  the former can retry the same batch; the latter detaches without returning
  members or invoking `queuePrompt` again after restart.
- Core-event integration tests submit multiple batches while one turn is active
  and prove each exact submission ID adopts only its own later turn and Answer.
- Projection tests prove one shared Run/Answer Card per batch, no per-member
  card intents, Main Card invalidation across collecting/formed/native-queued
  transitions, and outbox retry/redelivery without execution effects.
- Existing steering, priority, continuation, direct-Herdr, model-selection and
  legacy queued-Prompt tests remain green as compatibility evidence.
- Architecture tests verify inward imports and that the SQLite/Herdr/Lark
  representations remain behind existing or extended domain-owned ports.
- Each implementation ticket runs its focused tests plus `npm run typecheck`
  and `npm run build`. Full delivery runs `npm test` after build completion;
  those commands must not run concurrently because build atomically replaces
  `dist` while installer tests read it.

## Out of Scope

- Combining more than three source messages in one drain.
- Sliding or extending a collection deadline when later messages arrive.
- Creating separate Run/Answer Cards for batch members.
- Splitting one batch Answer back into per-message answers.
- Batching explicit steering, priority/control work, card continuations,
  internal Prompts, direct Herdr turns or Worker tasks.
- Remote approval, arbitrary terminal input, process kill or Pane kill.
- Replaying or reconstructing a possibly delivered native submission.
- Rewriting historical queued Prompts or production SQLite rows manually.
- Installing, activating, restarting, deploying, pushing or opening a PR.

## Further Notes

- Workspace mode: isolated Git worktree using the approved Git fallback because
  native worktrees under `.trae/worktrees` were mounted read-only in the
  sandbox.
- Workspace: `/tmp/herdr-agent-swarm-feishu-native-input-batching`.
- Branch: `worktree-fix/feishu-native-input-batching-v2`.
- Starting revision: `883f008f81dc37a61cd51ff10e0c7f4aad1d8bf0`.
- The starting revision includes the already completed, verified and
  undeployed `/swarm awake` durable card-redelivery commits. The original
  `main` checkout and both earlier `.trae` worktrees remain untouched.
- Relevant initial changes: none in this worktree. `npm ci` installed locked
  dependencies locally and reported two pre-existing high-severity audit
  findings; dependency remediation is outside this feature.
- Fresh baseline on 2026-10-02:
  - `npm run typecheck`: passed;
  - `npm run build`: passed and generated build identity
    `sha256:661f9a12f02a5d62cc86dab1c7ed54054b2f89aa9cc11e9dec2cbcbb7f3daac5`;
  - serial `npm test`: 237 files and 3,293 tests passed.
- An initial parallel validation caused 11 installer tests to observe `dist`
  while the concurrent build was replacing it. A serial test rerun passed all
  tests; this was validation interference, not a repository baseline defect.
- Gate 1 design was approved by the user on 2026-10-02.
- No unresolved load-bearing design decisions remain in this specification.
