# Feishu Stream Recovery Watchdog

## Problem Statement

Herdr and TraeX turns can continue and complete normally while the Feishu projection stops progressing. Production evidence includes Primary Answer failures during stream creation or content delivery and Worker Task failures during stream finalization. The durable Answer or Task content remains in SQLite, but existing outbox handling can exhaust retries or dismiss a defunct immutable target without making that content visible again.

The current system already persists workflow intent before delivery, retries ordinary outbox failures up to five attempts, rebuilds some Primary Main and closed Answer surfaces, and can create a top-level Feishu conversation. It does not provide one recovery owner that finds stranded Primary Answer and Worker Task projections, chooses a safe resume point, creates a stable replacement, and makes that replacement the sole future delivery target.

The intended change is delivery recovery only. It must never resubmit a prompt, replay a TraeX turn, infer execution state from Feishu, or invent content that is absent from durable projections.

## Solution

Add a durable Delivery Recovery Watchdog for Primary Answer and Worker Task projections. The watchdog is the single application-level owner for selecting recoverable delivery gaps and coordinating replacement targets. It runs periodically, at startup, and on immediate wake hints emitted after durable explicit-failure evidence is recorded.

An explicitly defunct target or closed stream becomes immediately eligible. Timeout, connection reset, network interruption, and other uncertain failures continue to retry the original target through the existing five-attempt policy and become eligible only after exhaustion. A recovery generation uses a stable recovery identity, freezes the old target, records the best durable cursor, and creates one successor target. When the successor creation is acknowledged, it becomes the only active target and delivery resumes from the last confirmed cursor. If that cursor is unusable, recovery converges from the latest durable event or timeline; if incremental recovery remains impossible, it publishes the durable final result.

The successor is created in the original thread when its root remains usable. When the original root or thread is proven defunct, the existing `conversation.create` Gateway capability creates a top-level recovery conversation in the configured Feishu group. The same recovery path handles new failures and startup backfill of historical gaps whose projection ownership and durable content can be proven.

Primary Main keeps its existing rebuild policy. Existing prompt admission, prompt FIFO, steering, turn observation, Herdr reconciliation, and execution identity are unchanged.

## User Stories

### S1: Resume a Primary Answer after an explicitly defunct target

Given a Primary Answer projection with durable content and a Feishu failure classified as a defunct target, the persisted failure immediately wakes the watchdog. The watchdog claims one recovery generation, freezes the old target, creates a successor, and resumes after the last acknowledged cursor. The Primary turn is not submitted again.

### S2: Recover a Worker Task after uncertain delivery exhaustion

Given a Worker Task stream whose delivery fails with timeout, reset, transport interruption, or an unclassified response with uncertain effect, the existing target is retried at most five times. The first four failures do not create a recovery target. Exhaustion makes the projection eligible for watchdog recovery and eventual successor delivery.

### S3: Fall back without guessing missing content

Given an unusable or absent delivery checkpoint, the watchdog uses the latest durable event or timeline to build a convergent successor projection. If incremental reconstruction is not possible and a durable final result exists, it publishes that final result. It never reads a Feishu card as canonical state and never fabricates missing output.

### S4: Recover when the original conversation target is gone

Given proof that the reply root or thread is defunct, the watchdog uses `conversation.create` to create a top-level recovery conversation in the configured Feishu group. After creation is acknowledged, that target becomes the sole target for later Answer or Task writes.

### S5: Converge duplicate watchdog triggers

Given simultaneous periodic, startup, and failure-triggered scans for the same projection, SQLite grants at most one active recovery generation. Repeated scans reuse or observe that generation instead of creating additional successor cards. A late success for an old target cannot reactivate it.

### S6: Resume recovery after process restart

Given a process exit while a recovery is eligible, rebuilding, or awaiting successor acknowledgement, startup recovery continues from the durable recovery state. It does not resubmit the associated Herdr prompt or repeat already-confirmed projection effects.

### S7: Refuse unprovable historical recovery

Given a historical dead letter or orphaned target whose Primary Answer or Worker Task ownership cannot be proven, the watchdog records or reports the unresolved item without publishing it into a guessed conversation.

### S8: Preserve final visibility

Given a completed Primary Answer or Worker Task with durable final content but no confirmed visible final projection, the watchdog eventually delivers either a resumed stream or a final snapshot. A recoverable failure cannot end in silent dismissal.

## Implementation Decisions

### Domain Model

The affected bounded contexts are Delivery and View Projection. Herdr Runtime remains an upstream source of canonical execution and event facts; it is not part of the recovery aggregate. Feishu remains an external projection target rather than a source of workflow truth.

Existing observed concepts retained by the design are outbound intent, delivery checkpoint, Answer page, Worker Task projection, immutable target, delivery lane, dead letter, Gateway identity, and startup recovery.

The proposed `DeliveryRecovery` aggregate represents one recovery generation for one recoverable projection. Its identity is stable for the tuple of projection kind, projection identity, and generation. Its lifecycle is:

`observing -> eligible -> rebuilding -> awaiting_ack -> active`

An item that cannot safely progress may enter `exhausted`. Successful activation is terminal for that recovery generation; later gaps start a new generation rather than mutating completed history.

The aggregate records:

- projection kind: `primary_answer` or `worker_task`;
- canonical projection identity and proven ownership references;
- failed target identity and failure evidence;
- last confirmed delivery checkpoint and latest durable projection cursor;
- original-target attempt count and normalized failure class;
- stable recovery identity and generation;
- fallback level: exact cursor, latest durable event/timeline, or final snapshot;
- successor creation intent and acknowledged successor target when available;
- lifecycle timestamps and terminal/exhaustion reason.

Recovery state values and projection kinds are closed internal sets validated at construction and reconstitution. A checkpoint is valid for exact resume only when it belongs to the same projection generation and its covered durable range is still available. Current eligibility is a transition policy, not intrinsic checkpoint validity.

`DeliveryRecoveryWatchdog` is the proposed domain-facing application service that evaluates durable recovery evidence and coordinates state transitions. The SQLite recovery store owns uniqueness, conditional transition eligibility, persistence, and conflict outcomes. Existing Answer and Worker reducers remain owners of rendered content; the watchdog does not become a presentation model.

The following invariants apply:

- A projection has at most one nonterminal recovery generation.
- Only a successor creation acknowledgement can install a new active target.
- Once frozen for a recovery generation, an old target cannot become active again.
- Canonical Answer or Task content continues to advance independently of Feishu target state.
- Recovery can create projection intents but cannot create, submit, or mutate a Prompt or turn execution.
- Historical recovery requires provable projection ownership and durable content.
- An eligible completed projection with durable final content must not be silently dismissed.

The transaction boundaries are:

1. **Claim and freeze:** claim the recovery generation, persist failure evidence and checkpoint selection, freeze the failed target, quarantine its undelivered mutable effects for audit, and reserve the successor creation intent atomically.
2. **Activate successor:** persist the acknowledged successor identity, install it as the projection's sole active target, materialize catch-up intents from the selected cursor, and mark the recovery active atomically.

Canonical projection events that arrive between those transactions remain in the existing Answer or Task timeline. Catch-up is calculated from durable state after successor acknowledgement, so recovery-period content is included.

### Architecture

`DeliveryRecoveryWatchdog` belongs in the application/coordinator boundary. It receives periodic, startup, and immediate wake triggers through the existing bounded runner/notifier patterns. Wake events are hints only; durable scans are authoritative.

The watchdog depends on small domain-owned ports:

- a recovery store that lists eligible evidence, conditionally claims generations, records successor acknowledgements, activates targets, and marks exhausted outcomes;
- a projection reader that returns proven ownership, checkpoint coverage, latest durable cursor, and final snapshot availability;
- a recovery intent factory that creates existing Gateway intents for in-thread stream replacement or top-level `conversation.create` fallback;
- an outbound notifier that wakes existing delivery draining after committed intent creation.

Concrete SQLite implementations remain under the store boundary. Gateway intent validation and conversion remain in the outbound Gateway path. Feishu-specific SDK normalization and error extraction remain in the Feishu adapter. The composition root assembles the watchdog and schedules its startup and periodic runs.

`OutboundDeliveryExecutor` retains responsibility for executing an intent, checkpointing success, normalizing failure evidence, and committing the existing delivery failure transition. For scoped projections it additionally issues a wake hint after durable explicit terminal-target evidence or retry exhaustion. It does not choose replacement policy or write Feishu cards directly.

The recovery intent factory emits only capabilities already present in the Gateway contract: `stream.create`, `stream.append`, `stream.finish`, and `conversation.create`. If top-level recovery needs a two-stage create-then-stream sequence, the first acknowledged intent supplies the successor conversation reference before the second intent is reserved. No Feishu SDK capability is inferred beyond the current adapter contract.

Dependency direction remains domain/application ports toward adapters. SQLite rows and Feishu SDK objects do not cross into the watchdog API; normalized identities, cursors, evidence, and intent descriptors cross the boundary.

### Behavior & Failure Modes

Eligibility requires durable evidence, not elapsed silence alone. A candidate must satisfy at least one of these predicates:

- an outbox effect proves the target defunct or the stream closed;
- an uncertain delivery has exhausted five attempts on the original target;
- a scoped dead letter has durable content beyond its acknowledged checkpoint;
- durable projection content advanced while no usable active target exists and ownership is proven;
- a completed projection has final durable content without a confirmed visible final state.

`300307` and other currently unclassified Worker Task finalization failures are treated conservatively as uncertain unless the Feishu classifier can prove the target is permanently unusable. `230011`/`230019` remain defunct-target evidence. Closed-stream and stale-sequence classifications remain operation- and projection-aware; expanding classification must not turn ambiguous transport failures into falsely certain effects.

Explicit evidence writes and commits before issuing an immediate watchdog wake. Uncertain failures continue through the current five-attempt outbox policy. Periodic scans provide eventual convergence if a wake is lost. Startup scans use the same selector and transition methods rather than a separate repair algorithm.

The recovery target policy is deterministic:

1. retain the original conversation/thread when its root remains usable;
2. use a top-level configured-group recovery conversation when the root/thread is proven defunct;
3. refuse delivery when group routing or projection ownership is unproven.

Resume selection is deterministic:

1. exact resume after the last acknowledged, coverage-valid checkpoint;
2. convergent rendering from the latest durable event/timeline;
3. durable final snapshot for a completed projection.

Fallback may duplicate a bounded amount of visible content but cannot skip known durable final content. The stable recovery identity and conditional generation claim bound duplicate successor creation. The system does not claim exactly-once external creation across an ambiguous Feishu acknowledgement; it provides at-most-one active local successor and eventual convergence. Ambiguous successor creation retries retain the same recovery generation and idempotency identity.

Old pending or retrying append/finish effects are quarantined or dismissed from scheduling when the target is frozen, while their audit evidence remains retained. A late delivery result for a frozen target can update audit facts but cannot mutate active-target ownership or schedule new old-target work.

Failure to prove ownership, construct any safe fallback, or create a successor after its bounded delivery policy moves recovery to `exhausted`. Exhausted recovery is visible in structured logs and operational status and remains available for later operator diagnosis; it never causes Prompt replay.

### Compatibility & Migration

The SQLite schema change is additive and migrates existing databases in place. It creates durable recovery storage and required uniqueness/selection indexes without rewriting prompt execution identity, Answer/Task canonical content, or completed outbox audit history.

Migration and startup backfill may create recovery candidates only when the existing rows prove projection ownership and contain durable Answer or Task content. Ambiguous historical rows remain untouched or are reported as unresolved. Existing Primary Main recovery continues through its current policy and is excluded from the new watchdog.

Readiness continues to represent service and dependency usability; the mere presence of a recoverable backlog does not make the service unready. Operational status and structured logs add recovery backlog count, oldest eligible age, active state counts, and exhausted count, correlated by projection ID and recovery ID.

No public command, Lark action, prompt contract, Gateway intent name, or configured-chat allowlist changes. Default scheduling can reuse the existing reconciliation interval unless implementation evidence shows a separate bounded configuration is required; introducing a new operator configuration would require returning to design rather than choosing it silently.

## Testing Decisions

Behavior changes follow Red-Green tests at existing public seams.

- Feishu delivery classification tests cover explicit defunct/closed outcomes and conservative uncertain handling for Worker Task finalization errors.
- SQLite store tests prove recovery round-trip across reopen, one-nonterminal-generation uniqueness, conditional claims, frozen-target enforcement, successor activation atomicity, checkpoint preservation, migration idempotence, and startup selection of only proven historical ownership.
- Outbox dispatcher/executor tests prove the first four uncertain failures stay on the original target, the fifth makes recovery eligible, explicit failures wake immediately after persistence, and late old-target results cannot reactivate a frozen target.
- Watchdog workflow tests walk S1-S8, including competing scans, lost wake hints, ambiguous successor acknowledgement, in-thread recovery, configured-group fallback, cursor fallback order, exhausted refusal, and new events arriving during recovery.
- Answer workflow and Worker Task integration tests prove catch-up content, final snapshot visibility, stream finish behavior, and stable successor targeting.
- Startup recovery tests prove nonterminal recovery resumes after reopen without prompt submission.
- Architecture-boundary tests prove the watchdog depends on domain/application ports and does not import Feishu SDK or concrete SQLite implementation details.
- Existing Primary Main rebuild, prompt concurrency, steering, Answer pagination, Worker delivery, and Gateway contract suites remain passing as regression evidence.

Tests must explicitly spy on or fake the prompt-submission boundary and assert zero submissions during every recovery scenario. Where external duplicate creation cannot be ruled out after an ambiguous acknowledgement, tests assert stable idempotency/recovery identity and one locally active successor rather than an unsupported exactly-once claim.

Affected verification is expected to include focused Vitest files, `npm run typecheck`, and `npm run build`. Because the change spans persistence, recovery, delivery, startup, and shared runtime behavior, final verification includes `npm test`.

## Out of Scope

- Replacing or redesigning Primary Main recovery.
- Remote approval, denial, arbitrary terminal input, process kill, or pane kill.
- Replaying or resubmitting Herdr/TraeX prompts.
- Reconstructing canonical state from Feishu card contents.
- Guaranteeing zero duplicate external cards after an ambiguous Feishu acknowledgement.
- Recovering rows whose projection ownership or configured-group destination cannot be proven.
- Adding new Gateway transport capabilities when current intents suffice.
- Pushing a branch, opening a pull request, or publishing external tickets.

## Further Notes

- Workspace mode: in-place in `/workspace/herdr-agent-swarm`.
- Rationale: the `main` checkout has no staged or tracked unstaged changes; this task owns new specification, plan, test, and implementation paths and does not require branch switching. Existing linked worktrees are left untouched.
- Branch: `main`, ahead of `origin/main` by 137 commits at planning time.
- Starting revision: `49c7f224e1b287ffa56f3b963d491cff39f1a3ec`.
- Protected initial untracked content: `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.
- Fresh baseline on 2026-10-02: `npm test` passed 235 files and 3304 tests; `npm run typecheck` passed; `npm run build` passed and generated build identity `sha256:e43c69195e7a0c46e125b13c0b6da95019928ff18975dc094c1acda7c051ee46`.
- No unresolved load-bearing design decision is known. A new operator-facing watchdog interval is not authorized; if existing scheduling cannot satisfy bounded immediate and periodic recovery, that evidence reopens Gate 1.
- Approval status: Gate 1 design and Gate 2 specification approved; implementation tickets pending Gate 3 approval.
