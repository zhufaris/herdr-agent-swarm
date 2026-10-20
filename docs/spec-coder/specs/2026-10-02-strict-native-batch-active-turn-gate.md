# Strict Native Batch Active-Turn Gate

## Problem Statement

The completed Feishu Native Input Batching design permits a formed ordinary
batch to call Herdr `agent.prompt` while the bound Primary is `working` or
`blocked`. It assumes Herdr/Core owns a semantic future-turn queue and that an
accepted submission will later receive its own Core turn.

Live evidence from Pane `wN:p5Q` disproves that assumption. Prompt A already
owned Core turn `01a0fd9b-4d6f-7962-9786-c76e1c9bd673` when Prompt B was
accepted. Core then projected B's Human Message onto A's same turn rather than
creating a second turn. B could not claim a distinct turn and correctly failed
closed as `recovering/detached` with no replay.

Herdr's actual contract serializes PTY text-plus-Enter writes. It does not
promise Agent-level future-turn scheduling. Swarm therefore violates its own
one-active-ordinary-turn invariant when it treats a formed Native Input Batch
as eligible merely because the PTY write was accepted.

## Solution

Restore one binding-scoped **Ordinary Execution Slot**. Active-turn input may
still be admitted, collected for the durable two-second window, and frozen into
a Native Input Batch. The formed batch remains durable in SQLite until every
earlier ordinary execution is terminal and the exact live Pane is `idle` or
`done`. Only then may the oldest formed batch cross the Herdr submission
boundary.

Enforce the rule at three independent seams:

1. `PromptRunWorkflow` may reconcile or form batches while a binding worker
   exists, but must not start a second native dispatcher.
2. The SQLite dispatch claim must atomically refuse every formed batch while a
   same-binding Prompt is `submitted`, `running`, `recovering`, or `uncertain`,
   and must require the persisted Agent state to be `idle` or `done`.
3. `PrimaryPromptDispatcher` must re-read the live Pane immediately before the
   external call and release an unstarted claim if the Pane is `working` or
   `blocked`, including for Native Input Batches.

The existing no-replay boundary is unchanged. A submission that may have
crossed into Core remains detached or uncertain and blocks later ordinary work
until exact observation, bounded recovery, or explicit `/swarm skip` resolves
it. No Herdr Core change, live database rewrite, prompt replay, service restart,
or deployment is part of this change.

## User Stories

### SCN-1: Active Primary collects without submitting

As a Feishu user, when the Primary owns an active ordinary turn, my later
ordinary messages are durably admitted and may form their normal bounded Native
Input Batch, but no batch text is written to the Pane while that turn remains
active, blocked, recovering, or uncertain.

### SCN-2: Settled Primary dispatches the oldest formed batch

As a Feishu user, when the predecessor becomes terminal and the exact Pane is
`idle` or `done`, the existing FIFO wake path submits the oldest formed batch
exactly once with its frozen body, batch/Prompt submission ID, and exact Agent
session fence. Later batches cannot overtake it.

### SCN-3: Runtime becomes busy after the durable claim

As an operator, when SQLite claims an eligible batch but the live Pane changes
to `working` or `blocked` before the Herdr call, Swarm writes no terminal input,
returns the still-unstarted claim to `queued/not_started`, and waits for a later
wake. This pre-effect retry does not change membership, body, ID, card, or
attempt ownership.

### SCN-4: Detached or uncertain work blocks the FIFO

As an operator, when a predecessor may have crossed the native boundary but has
no terminal result, no successor ordinary batch is submitted even if the Pane
appears idle. Recovery or creator-authorized `/swarm skip` owns release of that
blocker; scheduler state and Lark presentation do not.

### SCN-5: Accepted submissions remain no-replay

As an operator, once Core returns an accepted or otherwise possibly-delivered
receipt, the Prompt keeps its existing detached/uncertain lifecycle and exact
observation path. This change never converts such work back to queued and never
reconstructs or resends its batch body.

### SCN-6: Existing affected runtime state is preserved

As an operator, existing production rows such as Prompt B remain untouched.
After a fixed release is separately deployed, the active predecessor should be
allowed to settle and the detached blocker should be resolved through existing
observation or `/swarm skip`, not database surgery.

## Implementation Decisions

### Domain Model

The affected bounded context is Prompt Execution. SQLite remains authoritative
for Prompt Input membership, Native Input Batch formation, FIFO order, Prompt
lifecycle, dispatch evidence, and recovery state. Herdr remains authoritative
for live Pane/session identity and Agent state; it is a PTY submission adapter,
not the owner of future ordinary turns.

`Prompt Input`, `Collection Window`, and `Native Input Batch` retain their
existing meanings and atomic formation boundary. The former split between a
`Native Submission Slot` and an `Active Turn Slot` is withdrawn for ordinary
Primary work. One **Ordinary Execution Slot** covers selection, native
submission uncertainty, exact turn ownership, and recovery until the Prompt is
terminal.

#### INV-1: One nonterminal ordinary execution per binding

A binding may have at most one ordinary Prompt in
`submitted | running | recovering | uncertain` eligible to own or possibly own
runtime execution. A formed successor can exist, but cannot cross the external
submission boundary.

#### INV-2: Eligibility is an atomic durable decision

SQLite claims only the oldest formed batch when the persisted binding is
attached, generation/session-current, `idle | done`, and has no nonterminal
ordinary predecessor. The claim and Prompt transition remain one transaction.

#### INV-3: External submission requires fresh settled runtime evidence

After claim, the dispatcher must confirm the exact Pane/workspace/session and a
live `idle | done` state. `working`, `blocked`, `unknown`, missing, or changed
identity is a pre-effect refusal. Batch identity does not weaken this gate.

#### INV-4: Possible delivery is never replayed

Only work proven not to have started may return to queued. Accepted, prepared,
uncertain, timed-out-after-call, or mismatched receipt outcomes retain the
existing detached/uncertain no-replay path.

#### INV-5: Formation and backpressure remain independent of execution

Active-turn messages still use the approved fixed collection window, maximum
three-member FIFO drain, immutable frozen body, source idempotency, source-count
backpressure, and one shared Run/Answer projection. Waiting for the execution
slot does not reopen or reformat a formed batch.

### Architecture

#### ARCH-1: Workflow scheduling cannot create a parallel dispatcher

When `PromptRunWorkflow` receives `prompt-ready` for a binding with an existing
worker, it may call the existing durable batch reconciliation path and schedule
the next deadline. It must not call `PrimaryPromptDispatcher.drain` through a
separate native-submission worker. The normal worker-completion wake resumes the
FIFO after the execution owner settles.

The workflow retains its current public interface. Process-local workers and
timers remain hints; they cannot establish dispatch eligibility.

#### ARCH-2: The dispatch store owns the authoritative execution-slot claim

`SqlitePromptDispatchStore.claimNextDispatchablePrompt` remains the deep
transactional module. Its interface continues to return either one fully
fenced claim or `null`; callers do not reproduce predecessor-state queries.
The `nativeInputBatchOnly` selector may restrict which queued work is
considered, but cannot bypass the settled-state or nonterminal-predecessor
predicate.

#### ARCH-3: Dispatcher live preflight closes the claim-to-call race

`PrimaryPromptDispatcher` uses the existing Herdr port and runtime-identity
check. It rejects `working` and `blocked` for every ordinary claim. If the call
has not started, the existing release fence restores the exact claimed Prompt;
stale release loses safely. Receipt and post-call uncertainty handling remain
unchanged.

#### ARCH-4: Adapter vocabulary does not imply a future-turn queue

The existing `queuePrompt` TypeScript method may remain for compatibility in
this ticket, but documentation must describe it as receipt-bearing native
prompt submission/PTY serialization. No caller may infer future-turn ownership
from method naming, receipt acceptance, FIFO submission order, body equality,
or Pane status alone.

#### ARCH-5: Presentation and operations remain projections

Run/Answer/Main projections continue to derive from durable transitions. The
existing `nativeQueuedBatches` diagnostic field remains wire-compatible but
means a possibly submitted, not-yet-owned batch requiring observation; it is
not evidence that Core holds a semantic future-turn queue.

Source dependencies remain unchanged: coordinator workflows depend on
domain-owned Prompt Execution and Herdr interfaces; SQLite and Herdr adapters
implement those interfaces; composition wires concrete dependencies.

### Behavior & Failure Modes

- Batch formation while active succeeds durably but performs no Herdr call.
- Predecessor terminalization plus a normal scheduler wake makes the oldest
  formed batch eligible; duplicate wake hints converge on one SQLite claim.
- A stale persisted `idle` observation cannot cause a write if the fresh Pane
  preflight is busy.
- A detached/uncertain predecessor blocks successors until existing recovery
  changes it to a terminal state.
- A pre-effect rejection releases only the exact unstarted claim. A possibly
  delivered outcome never releases or replays.
- Restart recovery reads the same durable Prompt/batch states; it does not need
  a new migration or in-memory queue reconstruction.

### Compatibility & Migration

No schema migration or production-row rewrite is required. Existing batches,
Prompt IDs, cards, receipts, and recovery records remain valid. Existing
accepted-but-unowned batches retain no-replay treatment.

The previous Feishu Native Input Batching specification remains historical
evidence of the invalidated assumption. Current architecture/domain/operator
documentation must be updated to state the strict execution slot and remove
claims that Herdr/Core owns future-turn scheduling. Public Lark commands,
SQLite state values, health JSON fields, and Herdr adapter signatures remain
compatible in this fix.

## Testing Decisions

- Replace the concurrency test that currently expects active-turn
  `queuePrompt` with a Red-Green integration scenario: batches form while A is
  active, no native call occurs, A settles, the Pane becomes idle, and B is
  submitted exactly once with its original frozen body and identity.
- Dispatcher tests cover `working` and `blocked` batch claims as pre-effect
  refusals, release of the exact unstarted claim, and no call/receipt mutation.
- SQLite store tests prove `nativeInputBatchOnly` cannot claim through
  `submitted`, `running`, `recovering`, or `uncertain` predecessors and that
  duplicate/competing claims retain one winner after the predecessor is
  terminal.
- Workflow tests prove a `prompt-ready` hint under an existing worker performs
  reconciliation without a parallel dispatcher and that worker settlement
  wakes the normal FIFO.
- Existing no-replay receipt, restart recovery, batching, source backpressure,
  exact observation, steering, model selection, projection, and architecture
  tests remain green.
- Affected verification runs focused tests first, followed by
  `npm run typecheck`, `npm run build`, and `npm test` sequentially.

## Out of Scope

- Implementing a semantic future-turn queue in Herdr Core or TraeX.
- Converting ordinary Feishu input into implicit steering.
- Replaying, rebinding, or manually rewriting existing detached Prompt rows.
- Renaming public status fields or the Herdr port method in this ticket.
- Installing, activating, restarting, deploying, pushing, or opening a PR.
- Completing or dropping the separate `herdr-core` merge backup stash.

## Further Notes

- Workspace mode: isolated Host-managed worktree because the original checkout
  contains unrelated modified and untracked user work.
- Worktree: `/workspace/herdr-agent-swarm/.trae/worktrees/fix_active_turn_batch_gate`.
- Branch: `worktree-fix_active_turn_batch_gate`.
- Starting revision: `87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7`.
- The Host created the branch from `origin/main`; it was fast-forwarded to the
  current local `main` before dependency setup or artifact creation.
- Initial isolated-worktree changes: none. Original-checkout changes including
  `TODO.md`, temporary Core build/worktree directories, research/spec files and
  `handoff.md` remain untouched.
- Fresh baseline: `npm ci`; `npm run build` passed; `npm run typecheck` passed;
  `npm test` passed 251 files and 3,593 tests. The first pre-build test attempt
  failed only because `dist/build-info.json` had not yet been generated and is
  not baseline evidence.
- `npm ci` reported one existing high-severity audit advisory. Dependency
  upgrades are outside this behavior fix and do not block the green repository
  verification commands.
- No unresolved load-bearing design decision remains for implementation.
