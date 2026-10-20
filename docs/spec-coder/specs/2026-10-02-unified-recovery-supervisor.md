# Unified Recovery Supervisor

## Problem Statement

The service currently has two safe but separately operated recovery paths:

- execution observation recovery finds detached Primary prompts and observes the
  exact Herdr/TraeX turn without submitting the prompt again;
- projection delivery recovery rebuilds Primary Answer and Worker Task views
  from durable SQLite state and retries idempotent Feishu effects.

Both paths converge correctly within their own boundary, but they have separate
periodic runners, wake paths, lifecycle wiring, diagnostics, and user wording.
`/swarm awake` only attempts transcript recovery, while delivery recovery is an
internal watchdog. An execution result recovered now may therefore wait for a
later projection scan before its Feishu continuation is considered. Operators
also have to interpret unrelated status fields and the ambiguous phrase
"恢复观察" to tell which stage is active.

The intended change unifies the recovery control plane, not the recovery state
machines. It must preserve the different safety rules: execution recovery may
read an already-started exact turn but must never replay a prompt; projection
delivery recovery may rebuild durable views and retry idempotent Lark effects
but must never infer execution truth from Feishu.

## Solution

Add an application-level `RecoverySupervisor` that owns recovery scheduling,
coalesced wake hints, stage selection, cross-stage cascade, normalized status,
and the binding-scoped user entry point. It delegates work to two distinct
executors:

1. the existing execution-observation path (`PromptSafetyScanner`,
   `PromptRunWorkflow`, and `DetachedPromptObserver`), which retains exact
   pane/session/turn/start fences and the no-replay rule;
2. the existing `ProjectionDeliveryRecoveryWatchdog`, which continues to read
   canonical projections and delivery evidence from SQLite and to reserve only
   idempotent Gateway/outbox effects.

Startup, periodic scans, execution-terminal notifications, Answer checkpoints,
Worker Task checkpoints, and `/swarm awake` all enter the supervisor. A full
pass evaluates execution observation before projection delivery. A targeted
hint starts at the earliest stage that can own the referenced durable debt.
When execution observation settles a prompt, the supervisor immediately queues
that prompt for projection/delivery convergence instead of waiting solely for
the next periodic scan.

The supervisor exposes one normalized recovery view with these stage values:
`observing_execution`, `rebuilding_projection`, `delivering`, `awaiting_ack`,
`recovered`, and `needs_human`. These values are a read model derived from the
existing durable prompt, projection, recovery, and outbox records; they are not
a replacement persistence lifecycle and do not permit transitions across the
two safety boundaries.

`/swarm awake` remains accepted for compatibility but becomes the unified
binding-scoped recovery command. It resumes from the earliest missing stage:
execution observation when a detached prompt exists, otherwise projection or
delivery recovery when durable debt exists. User-facing execution text changes
from the ambiguous "恢复观察" to "恢复执行观察". The command reports the selected
stage and latest normalized state without claiming Feishu acknowledgement
before durable evidence exists.

## User Stories

### SCN-1: Resume a detached execution without replay

Given a binding whose earliest recoverable debt is a detached Primary prompt,
when startup, a periodic pass, a runtime hint, or `/swarm awake` requests
recovery, the supervisor selects execution observation. The existing observer
must match the exact binding generation, pane, native session, turn ID, and
canonical start time before accepting output. No code path submits the prompt
again.

### SCN-2: Continue directly into projection delivery

Given execution observation settles a prompt as completed or failed and commits
its lifecycle event, the supervisor queues the prompt's projection/delivery
stage immediately. The normal projector and durable outbox remain responsible
for materializing and delivering the view. A lost immediate hint is repaired by
the next durable full scan.

### SCN-3: Recover delivery when execution is already settled

Given a binding has no execution-observation debt but has a recoverable Primary
Answer or Worker Task projection, `/swarm awake` and a full supervisor pass skip
execution and invoke projection/delivery recovery from the durable checkpoint.
No Herdr/TraeX prompt or terminal input is produced.

### SCN-4: Coalesce duplicate triggers

Given startup, periodic, checkpoint, and user triggers overlap for the same
prompt or Worker turn, the supervisor coalesces the work key and each executor
retains its existing ownership/conditional-claim protection. Duplicate triggers
may cause another durable read but cannot create a second prompt execution or
install multiple active delivery targets.

### SCN-5: Resume after service restart

Given the process stops during execution observation, projection rebuilding,
delivery, or acknowledgement waiting, restart reconstructs work from the
authoritative SQLite records. The startup ordering still repairs historical
projection targets before the publisher may claim old-target effects, then
starts the common periodic supervisor after execution recovery is prepared.

### SCN-6: Report one recovery status without flattening semantics

Given an operator invokes `/swarm awake` or inspects service status, the system
shows the earliest active normalized stage and bounded diagnostics, including
the underlying recovery kind and correlation identity. `needs_human` includes a
reason when exact execution ownership, projection ownership, or a safe delivery
target cannot be proved. It never reports `recovered` merely because a scan was
requested.

### SCN-7: Preserve Worker delivery recovery

Given a Worker Task delivery checkpoint becomes recoverable, the supervisor
routes the targeted hint directly to the delivery executor. Worker Task
recovery does not enter Primary execution observation and retains the existing
Worker generation and delivery identity fences.

### SCN-8: Preserve progress when one item fails

Given one recovery item throws or becomes `needs_human`, the supervisor records
bounded diagnostics for that item and continues other eligible work. Periodic
recovery remains armed unless shutdown has begun.

## Implementation Decisions

### Domain Model

Two existing bounded contexts remain authoritative:

| Context | Authoritative state and language | Recovery responsibility |
| --- | --- | --- |
| Execution Observation | Binding generation, pane/session identity, Prompt lifecycle, exact TraeX turn and start boundary | Re-read and settle an already-dispatched turn without replay |
| Projection Delivery | Answer/Worker projection, delivery checkpoint, recovery generation, outbox intent and Lark acknowledgement | Rebuild canonical views and retry idempotent external effects |

`RecoverySupervisor` is an application coordinator across these contexts, not a
new aggregate and not a generic retry service. It does not own prompt,
projection, recovery-generation, or outbox state. The SQLite records owned by
the two contexts remain the recovery source of truth.

The normalized `RecoveryStage` is an immutable read value constructed only from
recognized stage names and a correlation identity. It describes the earliest
missing or active stage for display and diagnostics:

- `observing_execution`: exact-turn observation is required or active;
- `rebuilding_projection`: durable canonical view convergence is required;
- `delivering`: a durable outbound effect is eligible or executing;
- `awaiting_ack`: an effect has an uncertain or pending external acknowledgement;
- `recovered`: no earlier recoverable debt remains after a completed pass;
- `needs_human`: safety evidence is insufficient or the underlying recovery is
  exhausted, with a bounded reason.

These names do not replace existing prompt states (`running`, `recovering`,
`uncertain`, and observation states), delivery recovery states, or outbox
states. Translation belongs at the supervisor/status boundary. Equality is the
stage plus the scoped identity and underlying durable version or timestamp, so
stale observations cannot overwrite a newer status.

The following invariants apply:

- **INV-1 — No execution replay:** recovery never calls the prompt submission or
  terminal-input boundary for work that may already have reached TraeX.
- **INV-2 — Exact execution ownership:** recovered output is accepted only under
  the existing exact binding/pane/session/turn/start fences.
- **INV-3 — Durable delivery authority:** projection/delivery recovery reads only
  durable SQLite projection, recovery, checkpoint, and outbox evidence; Feishu
  content is never canonical input.
- **INV-4 — Idempotent delivery:** delivery retries retain the existing recovery
  generation, idempotency keys, frozen-target rules, and sole-active-target
  constraints.
- **INV-5 — Earliest-stage routing:** binding-scoped recovery cannot skip known
  execution-observation debt to report a later projection stage as recovered.
- **INV-6 — Durable-before-wake:** stage completion and new downstream intent are
  committed before an immediate next-stage hint is emitted.
- **INV-7 — Hints are lossy:** correctness does not depend on receiving any one
  wake hint; the periodic durable scan must rediscover unfinished work.
- **INV-8 — Failure isolation:** failure or human intervention for one work key
  does not stop unrelated recovery candidates.

No new business entity, repository aggregate, or generic persisted supervisor
state is introduced. Durable transitions stay within the existing prompt and
projection/delivery transaction boundaries. The supervisor's scheduling and
last-pass diagnostics are process-local and reconstructible.

### Architecture

`RecoverySupervisor` belongs in the coordinator/application boundary and owns a
single bounded periodic runner plus coalesced full, binding, Primary prompt, and
Worker turn hints. Its domain-owned port exposes lifecycle operations, targeted
requests, binding-scoped recovery, and a diagnostic snapshot. Callers do not
receive SQLite rows or Feishu SDK objects.

The execution executor exposes the minimum operations needed by the supervisor:
request/perform a durable safety scan, attempt the existing binding-scoped exact
turn recovery, inspect normalized execution debt, and notify when an observed
prompt settles. `DetachedPromptObserver` remains the only exact-turn observation
implementation. `PromptSafetyScanner` becomes a scan executor used by the
supervisor rather than retaining an independent periodic timer; prompt dispatch
continues through `PromptWorkScheduler` and `PrimaryPromptDispatcher`.

The delivery executor remains `ProjectionDeliveryRecoveryWatchdog`. It exposes
full and targeted convergence plus a normalized status snapshot, but does not
gain execution APIs. Its independent periodic runner is removed or disabled
when supervised so that periodic cadence has one owner. Answer and Worker
convergence workflows, SQLite conditional transitions, and the Gateway outbox
remain unchanged authorities.

Runtime flow is:

```text
startup / periodic / command / durable hint
                    |
                    v
           RecoverySupervisor
              |           |
              v           v
     execution observer   projection/delivery watchdog
        exact identity        SQLite -> outbox -> Lark
              |                         ^
              +-- committed outcome ----+
```

The composition root assembles both executors into the supervisor. Managed
startup preserves the existing pre-publisher projection-repair barrier, then
starts one periodic recovery cadence once prompt recovery is prepared. Shutdown
stops accepting new hints, drains or detaches execution observation according to
existing shutdown rules, and stops delivery convergence without discarding
durable work.

`CommandIntentDispatcher` depends on the supervisor's binding-scoped recovery
port instead of calling `PromptRunWorkflow.awake` directly. Existing command
authorization, frozen binding context, durable command intent, and replay policy
remain unchanged. `/swarm awake` remains the accepted syntax and idempotency
surface; this change does not add a second public command.

The service health/status snapshot includes supervisor runtime state, last scan
time/outcome, normalized stage counts, oldest pending age when available, and a
bounded last failure. The Feishu command result uses the same normalization and
states which stage was selected. It does not expose prompt bodies, transcript
content, credentials, raw SDK errors, or unbounded identifiers.

Source dependencies continue to point inward: composition and inbound command
adapters depend on the supervisor port; the supervisor depends on execution and
delivery ports; concrete SQLite, Herdr, Gateway, and Feishu implementations stay
outside the policy. The supervisor must not import a concrete SQLite store,
Herdr CLI adapter, Gateway adapter, or Feishu SDK type.

### Behavior & Failure Modes

A full scan is ordered but non-transactional across contexts:

1. scan durable prompt recovery work and schedule eligible detached observers;
2. scan durable Primary Answer and Worker Task recovery candidates;
3. record a normalized pass summary and arm the next bounded interval.

The supervisor does not wait for long-running detached observations before
allowing unrelated delivery candidates to progress. Ordering means candidate
selection starts at execution; work items run under their existing per-binding
or per-projection exclusion. When an execution item settles, the prompt-specific
delivery hint supplies the stage cascade. A failure in one stage is logged and
included in diagnostics, while the other stage and unrelated keys continue.

Targeted routing is deterministic:

1. a Primary binding request checks for detached execution debt first;
2. if present, it invokes existing exact-turn recovery and reports
   `observing_execution`, `needs_human`, or the resulting downstream stage;
3. if absent, it selects proven Primary Answer and Worker Task delivery debt
   belonging to that binding and requests convergence;
4. if no durable debt exists after the scoped pass, it reports `recovered` with
   a no-op explanation.

For a Primary prompt or Worker turn hint, the supervisor routes directly to the
known owning stage but still revalidates current durable identity before work.
Repeated hints are coalesced by typed work key. A hint received while that key
is active causes at most one follow-up durable check, preventing both missed
late work and unbounded duplicate loops.

Execution completion, failure, shutdown detachment, or ambiguous observation
continues to follow existing Prompt rules. Only a committed completed/failed
projection-producing outcome triggers immediate downstream delivery work.
`uncertain`, ownership mismatch, ambiguous transcript, or missing exact turn
does not manufacture a projection and surfaces as `needs_human` or remains
`observing_execution` according to existing bounded recovery policy.

Delivery failures retain their current classification. Explicit defunct-target
evidence and exhausted uncertain retries are recoverable; ambiguous external
acknowledgement keeps the stable delivery identity and maps to `awaiting_ack`.
The supervisor never retries an external effect outside the watchdog/outbox
contract and never claims exactly-once Feishu creation.

Startup uses durable scans as authority. The supervisor must not make the
publisher eligible to claim historical old-target effects before the existing
projection recovery barrier completes. If that barrier fails, startup fails or
degrades exactly as the current lifecycle contract specifies; it is not hidden
as a successful supervisor pass.

### Compatibility & Migration

No destructive database migration is required. Existing prompt, projection,
delivery recovery, and outbox records keep their meanings. If implementation
needs a status query, it is added behind existing store capabilities and derives
from current durable columns; it does not rewrite historical state into a new
generic recovery table.

`/swarm awake` remains valid with the same creator authorization and durable
command-intent idempotency. Its meaning broadens compatibly from execution-only
observation to earliest-stage binding recovery. Existing clients that only use
it for detached prompts continue to receive the no-replay behavior. Help and
operator documentation describe the broader behavior.

User-visible execution labels change from "恢复观察" / "恢复观察中" to
"恢复执行观察" / "恢复执行观察中" so they cannot be confused with delivery
recovery. Existing internal persisted run-card phase values are unchanged.

The existing `RECONCILE_INTERVAL_MS` remains the periodic cadence; no new
operator setting is introduced. Readiness semantics remain unchanged: a
recoverable backlog alone does not make the service unready, while supervisor
scan failures contribute to degraded operational status through diagnostics.

## Testing Decisions

Behavior changes use Red-Green tests at existing public seams:

- a new focused supervisor suite proves full-scan stage order, non-blocking
  progress across independent items, typed-key coalescing, one follow-up check
  for hints arriving while active, failure isolation, and clean shutdown;
- supervisor tests prove `INV-1` with a prompt-submission spy fixed at zero and
  `INV-2` by delegating only to the existing exact-observation port;
- `PromptSafetyScanner` tests prove it remains a deterministic durable scan
  executor after periodic ownership moves upward, including stale undispatched
  claim recovery and emitted scheduler hints;
- projection watchdog tests preserve full/targeted Primary and Worker
  convergence, duplicate coalescing, historical backfill, and delivery
  idempotency while periodic ownership moves upward;
- integration tests settle a detached prompt, assert the outcome is durable,
  and observe an immediate prompt-specific downstream recovery hint before any
  periodic tick (`INV-6`), then verify a dropped hint is repaired by a full scan
  (`INV-7`);
- command workflow tests prove `/swarm awake` chooses execution debt before
  delivery debt, recovers delivery when no execution debt exists, preserves
  authorization/idempotency, and reports `needs_human` without replay;
- managed-runtime tests prove historical projection repair still precedes
  publisher startup, one periodic supervisor is started, and shutdown ordering
  preserves the two executors' existing safety behavior;
- health/status and card tests prove normalized stage mapping, bounded failure
  fields, no sensitive content, and the "恢复执行观察" wording;
- architecture-boundary tests prove the supervisor depends only on the two
  internal recovery ports and does not import SQLite, Herdr adapter, Gateway
  adapter, or Feishu SDK modules.

Existing exact-turn recovery, prompt FIFO, steering, delivery recovery,
outbox/idempotency, Answer pagination, Worker Task, startup recovery, and
shutdown suites remain regression evidence. Affected verification includes the
focused suites, `npm run typecheck`, and `npm run build`; final verification
includes `npm test` because the change spans scheduling, startup, recovery,
delivery, commands, and health diagnostics.

## Out of Scope

- Combining execution observation and delivery retry into one persisted state
  machine or one generic `retry()` operation.
- Resubmitting prompts, replaying TraeX turns, or sending arbitrary terminal
  input as recovery.
- Reading Feishu cards as canonical workflow or projection state.
- Weakening exact identity fences, FIFO, Worker generation fences, delivery
  idempotency, frozen-target behavior, or outbox transaction boundaries.
- Guaranteeing exactly-once external Feishu effects after an ambiguous
  acknowledgement.
- Automatically skipping an execution whose result remains uncertain.
- Introducing remote approval/denial, process kill, or pane kill.
- Adding a second public recovery command or a new scheduling configuration.
- Pushing, opening a pull request, installing, or restarting the service.

## Further Notes

- Workspace mode: isolated linked worktree at
  `/tmp/herdr-agent-swarm-install-4e8db27a`.
- Rationale: the main checkout contains concurrent message-delete/outbox work;
  isolation is required to avoid mixing or overwriting those changes.
- Branch: `feat/unified-recovery-supervisor`.
- Starting revision: `524695929447efa5881d18065816cf685b6d10d1`.
- Initial change: the shared service-lifecycle fixture lacked an isolated
  `TRAECLI_HOME`, so its uninstall test inspected the user's live plugin state.
  The approved hermeticity correction was committed separately as `b3e0d090`.
- Fresh baseline after that correction on 2026-10-02: focused
  `tests/service-lifecycle.test.ts` passed 118 tests; `npm run typecheck`
  passed; `npm run build` passed with identity
  `sha256:409d36f211d7c9014f6d3f8bc0c7ee0fa22c99c1235166af92af5aa5ffd27498`;
  `npm test` passed 243 files and 3413 tests.
- No unresolved load-bearing design decision is known. If implementation
  evidence shows that existing durable records cannot distinguish one of the
  normalized delivery stages, the status must remain conservative rather than
  adding a guessed migration; a required persistence change would reopen the
  design gate.
- Approval status: Gate 1 design and Gate 2 specification approved; Gate 3
  implementation authorization pending.
