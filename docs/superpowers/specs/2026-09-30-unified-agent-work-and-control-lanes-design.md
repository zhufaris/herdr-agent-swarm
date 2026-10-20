# Unified Agent Work and Control Lanes Design

## Context

Herdr Agent Swarm accepts related work through several paths:

- ordinary Feishu messages addressed to a Primary;
- Agent-owned slash input such as `/plan` that Swarm does not interpret;
- turns started directly in a bound Herdr pane;
- `/swarm` mutations, natural-language management requests, and CardKit
  control actions;
- read-only status and topology queries.

The first three paths all represent Agent work, but they do not currently share
one admission boundary. Feishu work is created by `PromptAdmissionWorkflow`,
while a Herdr-origin turn is adopted later by `ExternalTurnObserver`. When a
Core event lacks `submission_id`, the adoption store can still associate it
with one queued Feishu Prompt using matching text and time. That heuristic can
assign a local turn to the wrong managed Prompt.

Control operations have a different problem. Literal and natural-language
mutations use durable `CommandIntent` records, but equivalent CardKit session
operations use a separate scanner. Natural-language confirmations persist a
frozen target identity, yet confirmation-time authorization does not compare
the newly resolved identity with that frozen identity. A reset or replacement
between request and confirmation can therefore retarget an operation.

## Decision

Unify all Agent-directed work behind one binding-owned Prompt lifecycle deep
module. Keep management mutations in a separate, durable control lane, and keep
authoritative queries out of both execution queues.

The design intentionally does not create one global FIFO for Prompts and
control operations. Their ordering, authority, retry, and settlement semantics
are different:

- a Prompt asks an Agent to do work and may be submitted to Core exactly once;
- a control operation mutates Swarm-, binding-, pane-, session-, model-, or
  Worker-owned state under an authorization and generation fence;
- a query reads authoritative SQLite and Herdr state without asking the Agent
  to infer it.

All user-visible effects continue to converge through the shared durable
Gateway outbox.

## Considered approaches

### 1. Unified Prompt lifecycle with a separate control lane

Selected. It removes the unsafe Agent-work identity split while retaining the
existing command authorization, uncertainty, and status-card contracts. It is
incremental and directly protects the remaining recovery acceptance work.

### 2. One generic `BindingWorkItem` table

Not selected for this release. A common envelope could share admission,
claiming, auditing, and settlement infrastructure while preserving separate
payloads and executors. It would, however, require migrations across
`prompt_jobs`, `swarm_command_intents`, health reporting, retention, and both
dispatchers. It would also invite an incorrect assumption that control work and
Agent work have a single execution order.

### 3. Durable binding event log with reducer-built projections

Not selected. Full event sourcing would give the strongest replay and audit
model, but the current system deliberately treats SQLite aggregates and the
outbox as durable authority while lifecycle events are process-local. Replacing
that model is much broader than the identity and control-lane defects.

## Work classification

Every ingress is classified before admission:

| Input | Work class | Durable owner | User-visible projection |
| --- | --- | --- | --- |
| Feishu ordinary text | Agent Prompt | Prompt lifecycle | Run and Answer cards |
| Non-Swarm slash input such as `/plan` | Agent Prompt | Prompt lifecycle | Run and Answer cards |
| Direct Herdr-pane turn | Observed Agent Prompt | Prompt lifecycle | Run and Answer cards |
| Worker task or follow-up | Worker Prompt | Worker lifecycle | Worker Task card |
| `/swarm` mutation | Control | Binding control lane | Command Status card |
| Natural-language mutation after confirmation | Control | Binding control lane | Command Status card |
| Equivalent CardKit mutation | Control | Binding control lane | Command Status card or action result |
| Status/topology query | Query | Authoritative query workflow | Query/status card |
| Human Review state | Notification | Projection/outbox | Review notification |

Human Review remains notification-only. Feishu cannot approve or deny a local
TraeX request, inject arbitrary terminal input, kill a process, or close a pane.

## Prompt lifecycle deep module

Introduce a binding-owned facade, named `BindingPromptWorkflow` in this design,
with three explicit operations:

1. `acceptManagedInput` admits Feishu text, Agent slash input, initial project
   Prompts, and idle-time steering that has already passed turn-control policy.
2. `adoptNativeTurn` records a canonical Core turn that already started in
   Herdr. It never submits text to Core.
3. `applyCoreObservation` applies Human Message, Agent output, tool, Goal, Task
   List, blocked, terminal, and exact-recovery evidence to an owned Prompt.

The facade owns the common Prompt aggregate boundary:

- `prompt_jobs` lifecycle and execution origin;
- Binding generation, pane, Agent kind, and native session fences;
- canonical Core submission and turn evidence;
- Run, Topic/Main, Answer, Goal, and Task List projections;
- projection-gap and exact-turn recovery bookkeeping;
- durable delivery intent and audit evidence;
- the no-replay rule.

The facade does not own Core command execution, Lark transport, terminal
parsing, card rendering, or query handling. `PrimaryPromptDispatcher` remains
the bridge-origin submission strategy, and `ExternalTurnObserver` remains the
Herdr-origin observation strategy. Both use the same lifecycle store instead of
implementing competing Prompt creation and terminal-settlement rules.

## Identity contract

### Managed Feishu Prompt

For every newly managed Feishu Prompt:

`prompt_id == native_submission_id == Core submission_id`

The inbound Lark message ID is admission idempotency evidence, not Prompt
identity. Queue position, text, timestamps, the newest turn, and the currently
active turn are never ownership evidence.

### Core event with `submission_id`

A Core event carrying `submission_id` can create or update only the Prompt with
that exact ID. Binding generation, pane, Agent kind, and native session must
also match. A mismatch fails closed and creates diagnosable recovery evidence;
it cannot fall back to content matching.

### Core event without `submission_id`

A canonical Core turn without `submission_id` is independent Herdr-origin
work. Its source identity is the exact tuple:

`(binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at)`

The store derives a stable external source key from that tuple and enforces its
uniqueness. On first observation it creates an `execution_origin='herdr'`
Prompt directly in `running/attached`; duplicate live hints or historical
recovery find the same Prompt. It never consumes or mutates a queued Feishu
Prompt, even when the text is identical.

The generated external Prompt ID is a stable implementation-owned identifier
derived from the exact source key. It is not sent back to Core and does not
pretend that the turn had a native submission ID.

### Persistence shape

Generalize Prompt ingress identity without breaking existing rows:

- retain `lark_message_id` as nullable compatibility/audit data;
- add `ingress_source` with explicit values such as `feishu`, `herdr`, and
  `internal`;
- add non-null `source_message_key` for new rows;
- enforce uniqueness on `(ingress_source, source_message_key)`;
- retain `execution_origin` to distinguish work Swarm may submit from work it
  may only observe;
- require `native_submission_id = id` for new bridge-origin Prompt rows;
- require exact turn identity before a Herdr-origin Prompt becomes attached.

Migration backfills Feishu rows from `lark_message_id`. Existing Herdr rows use
their persisted exact turn tuple when complete; incomplete legacy rows retain a
versioned legacy source key and remain recovery-only. Migration never guesses
identity from Prompt text.

## Prompt data flow

### Feishu-origin Agent work

1. Lark normalization and the durable inbound pipeline validate chat, actor,
   message size, and idempotency.
2. Routing classifies the input as Agent work.
3. `acceptManagedInput` atomically inserts the Prompt, initial Run/Answer
   projection, delivery intent, and audit record.
4. The per-binding dispatcher submits it through Core with
   `submission_id = prompt_id` in durable FIFO or declared priority order.
5. Canonical submission-keyed Core events attach exact turn metadata and drive
   all subsequent projections.
6. Delivery failures create projection/outbox debt but never change execution
   facts and never block admission or dispatch of unrelated Prompt work.

### Herdr-origin Agent work

1. A Herdr socket event wakes reconciliation; loss of the hint is recovered by
   periodic Core reconciliation.
2. The observer reads the canonical Core turn and exact source identity.
3. `adoptNativeTurn` idempotently creates or loads the Herdr-origin Prompt and
   its initial projections in one transaction.
4. `applyCoreObservation` projects the same event types used by managed
   Prompts, including Goal and Task List.
5. The observer settles the Prompt under exact identity fences and wakes
   downstream projection/outbox work.

The Herdr-origin path never inserts a fake queued state, invokes a Prompt
submission API, or changes the ordering identity of Feishu work.

## Control lane

All mutating Swarm controls targeting the same binding must share one durable
serialization lane regardless of whether they originated from literal text,
natural-language confirmation, CardKit, or a trusted tool. Global provisioning
and Worker-scoped operations may retain explicit scope lanes, but overlapping
operations must map to the same authoritative owner lane.

The shared control admission contract persists:

- source idempotency key and normalized command fingerprint;
- actor and authorization decision;
- binding, instance, and session identity as applicable;
- expected generations, pane, and exact turn fence;
- replay policy and effect-certainty state;
- Command Status projection and durable outbox intent.

Before executing an effect, the dispatcher reloads and compares every frozen
identity field. A same-name replacement, reset, reattach, new generation,
different pane, different session, or different active turn makes the command
stale. It is rejected before the effect and cannot be transparently retargeted.

Natural-language confirmation must compare confirmation-time resolution with
the stored expected identity. CardKit session mutations must be admitted into
the same binding control lane as equivalent slash commands instead of using an
independent scanner that can race them.

Control operations remain outside Prompt FIFO:

- `/stop` and active-turn steering require an exact active-turn fence;
- reset, replace, attach, close, resume, rename, model, and Worker lifecycle
  commands mutate coordinator-owned state;
- an external effect that may have started before failure settles as
  `uncertain` and is never replayed automatically;
- status and topology queries read authoritative state directly and do not
  create `CommandIntent` or Prompt rows.

Idle-time steering may become a priority Prompt only after turn-control policy
proves there is no exact active turn. It then uses `acceptManagedInput`, so its
atomic projection, lifecycle event, audit, and wake behavior match every other
managed Prompt.

## Ordering semantics

Prompt ordering and control serialization are both durable but intentionally
independent:

- ordinary Prompt work is ordered per binding by priority and durable admission
  order, then offered to the Core queue exactly once;
- control mutations are ordered within their authoritative owner lane;
- query operations do not participate in either execution queue;
- no cross-lane ordering is inferred from Feishu receive time.

This means a stop operation does not wait behind a detached Prompt, and a
Prompt cannot silently act as a reset or approval command. When a control
operation changes a generation or session, normal Prompt and observer fences
cause stale work to detach, reject, or settle through their existing safe
recovery rules.

## Failure and recovery semantics

- Admission of a managed Prompt, its initial projections, and delivery intent
  is atomic. A failed transaction leaves the durable inbound message retryable.
- A Prompt that is proven not to have started may return to queued. Once Core
  may have accepted it, Swarm observes or detaches it and never resubmits text.
- Herdr-origin work is observation-only and can never enter a submission retry.
- Missing or mismatched submission identity cannot mutate a managed Prompt.
- Exact historical recovery can replay durable projection, not Agent work.
- A projected terminal Core event with an unsettled owner Prompt is repaired by
  an idempotent, exact-fenced owner transition.
- Persistent exact `not_found` is bounded. It either converges after historical
  indexing or terminalizes as uncertain with explicit no-replay audit evidence
  and releases later work.
- Projection and CardKit delivery failures are isolated from Prompt execution
  and from unrelated owner lanes.
- A control effect that failed before execution may be retried according to its
  policy. A control effect that may have started settles as uncertain.
- One malformed or failed inbound message, Prompt, command, projection, or
  delivery cannot block later unrelated work.

## Compatibility and rollout

Implement in additive stages:

1. Add and backfill source identity columns and integrity checks.
2. Introduce the Prompt lifecycle facade over existing store transactions.
3. Route managed admission and idle steering through the facade.
4. Route exact native adoption through the facade and delete text/time matching.
5. Route common Core observation and owner settlement through the facade.
6. Fence natural-language confirmation against stored identity.
7. Admit equivalent CardKit mutations into the shared control lane.
8. Remove superseded duplicate paths and tests only after migration and restart
   recovery coverage passes.

No stage may rewrite live Prompt identity, replay Prompt text, delete durable
failure evidence, or infer ownership for incomplete legacy rows. Core and Swarm
deployment remain explicit operator actions. Existing production acceptance is
performed only after the candidate build, migration, and restart safety checks
pass.

## Verification

### Prompt identity and ordering

- Feishu ordinary text and non-Swarm slash input each create exactly one Prompt
  and preserve durable FIFO/native submission order while the Agent is busy.
- A managed Prompt uses the same ID for Prompt and Core submission.
- A Core event with the same submission ID updates the existing Prompt and does
  not create a duplicate.
- A Core turn without submission ID and with text identical to a queued Feishu
  Prompt creates a distinct Herdr-origin Prompt.
- Repeated live hints and historical batches for one exact Herdr turn remain
  idempotent.
- Restart continues work proven not started; accepted or uncertain work is only
  observed and is never resubmitted.

### Projection and recovery

- Feishu- and Herdr-origin turns use the same Human Message, Agent output, tool,
  Goal, Task List, blocked, and terminal projection rules.
- A terminal event already committed to the Core inbox can repair its exact
  unsettled Prompt owner without another Human Message.
- Exact historical recovery converges or reaches bounded uncertain settlement;
  it cannot loop indefinitely or bind a different turn.
- Answer, Main, and Worker delivery failure does not block later Prompt
  dispatch, and immutable-effect replacement remains owner-fenced.

### Control and authorization

- `/swarm stop`, active steering, model/session mutations, and Worker lifecycle
  operations create control work, never Prompt work.
- Literal, confirmed natural-language, CardKit, and trusted-tool forms of an
  equivalent binding mutation serialize in one lane.
- A generation, pane, session, instance, or active-turn change between request
  and execution rejects the operation before any effect.
- A command interrupted after an external effect may have started becomes
  uncertain and is not absorbed or replayed by Prompt recovery.
- Query commands return authoritative state without creating Prompt or command
  execution records.
- Blocked/local-approval state never causes remote approve, deny, arbitrary
  terminal input, process kill, or pane kill.

### Live acceptance

After an explicitly authorized deployment:

- Feishu messages A, B, and non-Swarm slash input C submitted while A is active
  each run once in admission order; `/swarm status` remains outside Prompt FIFO.
- Existing card lanes advance during startup recovery without a new Human
  Message and without new owner-scoped idempotency conflicts.
- Existing exact-turn recovery debt reaches a terminal result without an
  unbounded `turn_not_found` loop or Prompt replay.
- A new direct Herdr-origin turn containing tool activity, Goal, and Task List
  converges to one complete Feishu Answer Card under one exact turn identity.
- Health is ready or any remaining degraded condition is unrelated and
  explicitly documented; `multiple_running_turns`, blocked outbox lanes, and
  pending turn recovery are zero for the acceptance scope.

## Non-goals

- Do not merge Agent Prompt and control mutations into one FIFO.
- Do not make Lark cards authoritative for execution state.
- Do not make Herdr socket hints a durable source of truth.
- Do not add remote approval or arbitrary terminal control.
- Do not change Worker Prompt storage merely to share a table with Primary
  Prompts; Worker flow should reuse the same identity principles through its
  own aggregate boundary.
- Do not replace the current architecture with full event sourcing.
