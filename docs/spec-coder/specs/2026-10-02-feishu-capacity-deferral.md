# Feishu Prompt Capacity Deferral

## Problem Statement

Ordinary Feishu messages are durably recorded in `inbound_messages` before
routing, but the later Primary Prompt admission path still treats
`MAX_QUEUE_DEPTH` exhaustion as a permanent user rejection. The SQLite Prompt
acceptance transaction throws `This topic's prompt queue is full`,
`PromptAdmissionWorkflow` catches that string, reserves a `请求未执行` card, and
returns no Prompt. The durable inbound pipeline then marks the source message
accepted even though it never entered the Prompt Input or Native Input Batch
workflow.

This behavior is especially visible when a person sends several Feishu
messages while a Primary is busy. It contradicts the newer durable inbound and
Native Input Batch architecture: the source message already has a recoverable
SQLite owner, but an older compatibility path discards its future execution in
favor of terminal feedback.

The intended result is that an ordinary Feishu message waits durably when the
Prompt source-work limit is full, preserves topic FIFO, and enters the existing
batching path after capacity returns. Capacity pressure is not a successful
Prompt acceptance, a permanent rejection, or an operational failure.

## Solution

Keep `MAX_QUEUE_DEPTH` as the hard bound for accepted, nonterminal Prompt source
work. Reuse `inbound_messages` as the durable waiting area before that bound:

1. SQLite Prompt acceptance retains its atomic capacity check but reports a
   typed capacity condition instead of a string-only generic error.
2. `PromptAdmissionWorkflow` translates only that typed condition into a
   `capacity_deferred` result and no longer creates a rejection card.
3. `InboundMessageRoutingWorkflow` exposes a `deferred` routing disposition for
   the original Feishu message.
4. `DurableInboundPipeline` returns the claimed message to durable `received`
   state without an error, skips the rest of that scope for the current pass,
   continues draining other scopes, and uses its existing bounded retry timer.
5. A later retry performs normal idempotent admission and only then marks the
   inbound message accepted.

No new queue table or schema migration is required. The existing inbound row is
the waiting obligation, while `prompt_inputs`, Native Input Batches, execution
Prompts, and their projections remain bounded by the configured depth.

## User Stories

### SCN-1 — Ordinary Feishu capacity waits instead of rejecting

When an ordinary Feishu message reaches an active Binding whose accepted source
work is at `MAX_QUEUE_DEPTH`, the user receives no `请求未执行` card. The source
message remains durable and retryable, and no Prompt Input, batch member,
execution Prompt, Run Card, Answer Card intent, or completion-action cleanup is
partially committed.

### SCN-2 — Capacity release admits the waiting message once

When capacity later becomes available, the oldest waiting message for that
Feishu topic is retried through the same normal admission interface. It enters
the immediate or collecting Native Input Batch path exactly once according to
the then-current Binding state. Its existing Feishu message identity supplies
deduplication across retries.

### SCN-3 — One full topic does not block other topics

Within one inbound drain pass, a capacity-deferred message prevents later
messages in the same scope from overtaking it, while messages from other scopes
remain eligible. The dispatcher schedules another bounded retry without
reporting a service failure.

### SCN-4 — Restart preserves capacity waiting

If the service stops or crashes before capacity returns, startup recovery leaves
or restores the claimed inbound message to `received`. A later drain retries it;
no Prompt or TraeX submission is replayed.

### SCN-5 — Permanent rejection behavior remains explicit

Oversized input, authorization failures, invalid commands, Worker queue limits,
priority conflicts, steering rules, and other existing permanent rejection
paths retain their current user-visible behavior. Only ordinary Feishu Primary
Prompt capacity exhaustion becomes deferred.

## Implementation Decisions

### Domain Model

The affected contexts are Inbound Message Processing and Primary Prompt
Admission.

- A **Capacity Deferral** means the source message is durably owned but has not
  crossed the Prompt admission boundary. It is neither accepted execution work
  nor a rejection.
- `inbound_messages` is authoritative for the deferred source message.
- `prompt_inputs` and legacy nonterminal Prompt jobs are authoritative for
  consumed `MAX_QUEUE_DEPTH` capacity.
- The Feishu message ID remains the idempotency identity across every retry.
- The existing per-scope inbound order is the ordering boundary. A deferred
  head prevents later messages in the same scope from being claimed in that
  pass.

The following invariants apply:

- **INV-1 — Bounded execution source work:** `MAX_QUEUE_DEPTH` continues to
  count accepted nonterminal Prompt Inputs plus applicable legacy Prompt jobs.
  Deferred inbound rows do not consume Prompt capacity.
- **INV-2 — No partial admission:** the capacity decision and any Prompt
  Input/batch/projection/outbox writes remain inside the existing SQLite
  acceptance transaction. A capacity deferral commits none of those writes.
- **INV-3 — Durable FIFO:** a deferred scope head remains the oldest retryable
  inbound row and later rows in that scope cannot overtake it.
- **INV-4 — Idempotent retry:** repeated routing of one Feishu message either
  observes its previously accepted source identity or performs one new
  acceptance. It cannot create duplicate membership, Prompt, projection, or
  delivery intent.
- **INV-5 — No replay:** capacity retry occurs before Prompt admission and does
  not call Herdr or TraeX. Existing accepted, submitted, uncertain, recovering,
  or running Prompt work is never resubmitted by this flow.
- **INV-6 — Capacity is not failure:** expected capacity deferral does not set
  inbound `error`, update failure diagnostics, or emit an error-level log.

No new aggregate, generic retry framework, or second queue abstraction is
introduced. The existing durable inbound pipeline remains the recovery owner.

### Architecture

The domain layer owns a typed Prompt-capacity condition so callers do not match
an English error string. SQLite adapters raise that condition only after the
existing duplicate lookup and binding/generation fences and before any new
admission rows are written. Other validation and conflict failures remain
unchanged.

`PromptAdmissionWorkflow` owns translation from Prompt capacity to the
application-level result:

- `accepted` carries the existing execution Prompt or batch identity;
- `capacity_deferred` carries no Prompt identity and causes no presentation
  effect.

`InboundMessageRoutingWorkflow` maps this result to a typed `deferred`
disposition. It does not know SQLite state names or retry timing.

`DurableInboundPipeline` owns the interaction between routing disposition and
durable inbound state. Its store interface gains a focused defer operation that
returns the claimed row to `received` while clearing `error`. On `deferred`, the
pipeline excludes the message's scope for the rest of the pass, continues other
scopes, and schedules the existing exponential retry from 250 ms up to 30 s.
It emits a bounded, content-free informational record correlated by event and
message identity; it does not update `lastFailure`.

Source dependencies remain inward: coordinators and the SQLite adapter depend
on domain-owned result/error types and ports. Presentation is removed from the
capacity path rather than injected into persistence or retry logic. Composition
continues to assemble the existing workflow, router, store, and inbound
notifier; no new external adapter is needed.

### Behavior & Failure Modes

- Capacity can change between attempts. Each retry evaluates the current
  transaction state; no reservation is inferred from a previous failure.
- A duplicate retry checks source identity before capacity and converges to the
  existing accepted result.
- A deferred message remains `received` with `error = NULL`. Startup recovery
  already converts interrupted `processing` rows to retryable `received`.
- A true routing/storage failure continues through the existing release,
  `lastFailure`, error log, and bounded retry behavior.
- If capacity never returns, the message stays durable and is retried at the
  existing maximum interval. This design does not claim bounded total
  `inbound_messages` growth; existing database/disk health monitoring remains
  the operational safety boundary.
- New inbound hints may wake the coalescing drain before the timer. The
  transactional capacity check and per-pass scope exclusion prevent
  overtaking; no special prompt-completion-to-inbound coupling is added.

### Compatibility & Migration

- No SQLite schema migration or data rewrite is required.
- Existing `received` and recovered `processing` inbound rows remain compatible.
- The user-visible string `This topic's prompt queue is full` is removed only
  from ordinary Feishu Primary admission feedback. It may remain relevant to
  separately scoped legacy/internal or control flows until their own contracts
  change.
- `MAX_QUEUE_DEPTH` configuration, source-work counting, batch size, collection
  window, submission serialization, and completion-action supersession remain
  unchanged.

## Testing Decisions

- At the SQLite public seam, fill source capacity and prove a typed capacity
  result occurs before any partial Prompt Input, Native Input Batch, Prompt,
  projection, outbox, or completion-action mutation. Preserve duplicate-first
  behavior.
- At `PromptAdmissionWorkflow`, prove capacity maps to
  `capacity_deferred` and reserves no rejection card.
- At `InboundMessageRoutingWorkflow`, prove ordinary Feishu capacity produces
  `deferred`, while permanent rejections keep their existing disposition and
  presentation.
- At `DurableInboundPipeline`, prove a deferred row returns to `received` with
  no error/failure diagnostic, later same-scope work cannot overtake it, another
  scope proceeds in the same pass, and a later retry becomes accepted once.
- Add a reopen/recovery case showing an interrupted or deferred inbound row is
  retried without duplicate Prompt admission or TraeX submission.
- Preserve Native Input Batch source-depth, FIFO, duplicate, atomicity, and
  completion-action cleanup tests.
- Run focused workflow/store/integration tests, architecture boundary tests,
  `npm run typecheck`, `npm run build`, and the full `npm test` suite.

## Out of Scope

- Removing or raising `MAX_QUEUE_DEPTH`.
- Adding a second overflow table, a new schema migration, or a new waiting card.
- Changing Worker, priority, explicit steering, command, authorization, or
  oversized-input rejection semantics.
- Adding a direct Prompt-completion wake dependency to the inbound pipeline.
- Installing, restarting, deploying, merging main, pushing, or opening a PR.

## Further Notes

- Workspace mode: isolated Git worktree.
- Workspace: `/tmp/herdr-agent-swarm-feishu-capacity-deferral`.
- Branch: `fix/feishu-capacity-deferral`.
- Starting revision: `87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7` from current local `main`.
- Isolation reason: the original checkout contains a modified `TODO.md` and
  unrelated untracked work; the prior unified-session-events worktree diverges
  from the newer local main revision.
- Original checkout changes were not copied, stashed, reset, or edited during
  workspace preparation.
- Dependency preparation: `npm ci` passed with one existing high-severity npm
  advisory.
- Focused baseline: 4 files and 526 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed with build identity
  `sha256:34c6d4cf67be315cb9d0efe1a61f064f6ecea29f7e1fb1e55c8388e2fd8bd43c`.
- Full baseline: 251 files and 3,593 tests passed.
- Gate 1 design, Gate 2 specification, and Gate 3 ticket implementation were
  approved on 2026-10-02. No
  implementation, install, restart, deployment, main merge, push, or PR is
  authorized by this document.
