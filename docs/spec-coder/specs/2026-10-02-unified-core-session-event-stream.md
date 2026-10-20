# Unified Core Session Event Stream

## Problem Statement

Herdr Agent Swarm currently has two observable defects with one underlying boundary problem.

First, a Native Input Batch stores and submits the same formatted body. The formatted body contains presentation-only markers such as `[Feishu message 1/2]`, so those markers leak into the text sent to the Agent. The original member bodies already exist durably in `prompt_inputs`, but dispatch does not expose a separate execution body.

Second, a successful native prompt call is shown as `Native submission accepted; awaiting exact Core turn identity without replay`. Swarm treats a later JSONL-derived Human Message and exact Core turn identity as required ownership evidence even though JSONL may not exist when the PTY submission succeeds. This makes an implementation detail of an Agent transcript into a business-state prerequisite.

The current default `events` reader is not path-free. Swarm resolves an Agent transcript descriptor, including its filesystem path, and passes that path to `herdr agent events attach`. Core then tails the file into its own SQLite journal. Core also has a separate in-memory `EventHub`: it retains up to 512 Core-native workspace, tab, pane, and Agent-status events for `events.subscribe`, but that ring is volatile and separate from the durable Agent event journal.

The intended boundary is:

- Herdr Core owns Agent source discovery, Agent-format parsing, Core-native runtime facts, resumable event history, and submission receipts.
- Swarm consumes a path-free Core service, keeps a bounded local ingestion ring, and persists accepted batches and cursors in its existing `core_event_inbox` before projection.
- JSONL may remain a Core-internal observation source, but is not a Swarm contract or a submission-success signal.
- Human Message to Core turn association is advisory. It is not required to acknowledge submission and must never authorize replay.

The outbound boundary has a related coupling problem. Durable Feishu work is selected from the SQLite outbox and immediately started as delivery promises. Existing scan and concurrency limits bound each drain, but there is no explicit bounded buffer between durable lane-head selection and the external Feishu transport. The requested boundary must make that buffer visible without turning it into a second outbox or weakening lane ordering, claim, retry, or uncertain-effect guarantees.

## Solution

Add an additive, capability-advertised Core Session Event Stream API. It opens a stream from a Pane identity without accepting a transcript path, returns a stable stream epoch and cursors, and exposes ordered resumable batches containing both normalized Agent-derived events and selected Core-native events.

Reuse Core's existing facilities rather than adding a third event subsystem:

- `EventHub` remains the volatile low-latency fan-out/ring for Core-native notifications.
- the Agent event SQLite journal becomes the durable ordered history for session events that downstream consumers must recover;
- a durable journal commit publishes an EventHub wake-up/reference, while cursor reads remain authoritative;
- high-volume or presentation-only Core events are not copied into the durable session stream unless they are part of its contract.

In Swarm, add one bounded ingestion ring between the Core socket adapter and `core_event_inbox`. The ring absorbs short producer/consumer speed differences and provides one ordered ingestion seam to all projection workflows. It is not authoritative: events and their Core cursor are transactionally ingested into SQLite, and restart or overflow recovery resumes from the last durable cursor.

Add a second bounded, lane-aware Delivery Ring between durable outbox lane-head selection and the Feishu transport. The ring contains only rediscoverable outbox work references. The durable outbox remains authoritative for payloads, ordering, idempotency, retry/cooldown, checkpoints, and quarantine. Ring workers revalidate and claim an item immediately before the external call. A full ring stops further selection instead of dropping or overwriting work; a crash loses only volatile references, which the outbox scan rediscovers.

Native submission acceptance is determined by the Core PTY submission receipt. Core records a no-replay boundary before bytes may reach the PTY, records accepted after the text and Enter submission boundary completes, and exposes a queryable receipt if the client response is lost. Later Agent-derived turn information may enrich the observation, but no exact Human Message-to-turn match is required.

Native Input Batch display and execution text are separated. Existing formatted bodies remain available to Run Card and audit projections. Dispatch reconstructs `executionBody` from the immutable ordered raw batch members and never strips marker-like text with a regular expression.

The change is staged and compatible:

1. Core adds the new session stream capability and methods without changing the existing `events.*` or `agent.events.*` method shapes.
2. Swarm prefers the new capability and keeps its current legacy `events`, `jsonl`, and `shadow` paths as explicit transition/rollback modes.
3. Removing legacy modes is a later compatibility decision after the minimum supported Core version is raised.

## User Stories

### US1 — Clean Native Input Batch execution

When one to three Feishu messages form a Native Input Batch, the user may still see message-number markers in the Run Card, but TraeX receives only the original member bodies in durable ordinal order separated by blank lines.

If a member row is missing or inconsistent, dispatch fails closed before submitting anything. A body that literally contains `[Feishu message 1/1]` is preserved verbatim.

### US2 — Immediate submission acceptance

When Core confirms that a native prompt crossed the PTY submission boundary, Swarm records it as accepted/no-replay immediately. It does not wait for a JSONL file, Human Message event, turn ID, or exact turn start time.

If a deterministic validation failure occurs before the no-replay boundary, Core reports rejection. If Core or the connection fails after work may have crossed the boundary, the durable receipt reports an uncertain state and Swarm observes or escalates without replay.

### US3 — Path-free session stream

Given a live Pane with an Agent session, Swarm opens the Core Session Event Stream using Pane identity. Core validates the current terminal, Agent kind, and session epoch and discovers the underlying source internally. Neither the API request nor Swarm persistence contains an Agent transcript path.

### US4 — Unified live ingestion

Agent messages, tool/lifecycle events, submission receipts, and selected pane/session/runtime facts arrive through one ordered Core stream contract. Swarm places decoded envelopes into one bounded ingestion ring and drains them into `core_event_inbox` before business projection.

Duplicate delivery of an event is idempotent by stable event ID. Repeated or stale batches cannot move the durable cursor backward.

### US5 — Slow consumer and ring saturation

If Swarm projection is slower than Core delivery, the bounded ingestion ring applies backpressure. It must not overwrite unread entries. A closed or paused subscription is reopened from the last cursor committed with `core_event_inbox`, so the Core journal supplies the missing range.

### US6 — Swarm restart or socket interruption

After Swarm restarts or its Core socket disconnects, it first drains any durable inbox debt and reconnects using its persisted Core cursor. Events accepted by Core but not yet stored by Swarm are returned by Core history. TraeX input is never replayed as part of this recovery.

### US7 — Core restart, source replacement, and cursor expiry

Core reopens its durable journal and continues the same retained stream when possible. Partial JSONL records are not emitted until complete; stable event IDs suppress duplicates after reread. Truncation, rotation, or a new Agent session creates an explicit source/session epoch transition rather than silently reusing identity.

If a requested cursor predates retention, Core returns a typed gap with its earliest cursor. Swarm reconciles from durable receipts and a fresh Core snapshot. Any remaining ownership ambiguity becomes `needs_human`; it never becomes permission to resubmit.

### US8 — Managed and direct Human input coexist

A managed submission is fenced by its Core submission receipt and stream position. Later turn metadata is an optional correlation hint. A direct Herdr Human input is represented as an external event and may create or continue an external Prompt projection under existing policy.

When ordering evidence is insufficient to distinguish managed and direct work, Swarm does not claim exact ownership. It preserves no-replay and records an explicit uncertain/needs-human outcome.

### US9 — Older Core compatibility

When the new capability is absent, Swarm follows the explicitly configured legacy observation path and reports the degraded compatibility mode. It never invokes a new method on an old Core and interprets success incorrectly.

### US10 — Buffered, recoverable Feishu delivery

When durable outbox work is ready, the dispatcher selects eligible lane heads into a bounded Delivery Ring before any Feishu call starts. Up to the existing delivery-concurrency limit may be active, but only one item for a lane may be queued or active and live/history work retains the existing fair scheduling policy.

If the ring is full, selection pauses without deleting, overwriting, claiming, or postponing durable rows. If a queued reference becomes stale because its lane, fence, cooldown, or durable state changed, claim-time revalidation skips it and a later outbox scan discovers the current eligible head.

On shutdown, the dispatcher stops filling the ring and starts no new external calls after the delivery stop boundary. Already active calls follow the existing bounded drain/checkpoint policy. Unstarted volatile references may be discarded because their durable outbox rows remain pending and rediscoverable after restart.

## Implementation Decisions

### Domain Model

#### Core Session Event Stream

A Core-owned ordered stream for one live Agent session epoch. Its public identity is derived from Core-owned Pane, terminal, Agent kind, and native session facts. The transcript path and file identity remain internal source metadata.

The stream contains only facts required to observe and recover Agent execution. It is not the complete UI `EventHub`, and it does not make Lark or Swarm workflow concepts part of Core.

#### Session Event Cursor

An opaque Core-issued position within one stream epoch. Cursors are ordered only within their stream. They are immutable, reject cross-stream reuse, and expose earliest/latest boundaries for recovery.

Core journal sequence is the durable ordering authority. Existing volatile `EventHub` sequence is a wake-up/fan-out mechanism and is not persisted as the session cursor.

#### Swarm Ingestion Ring

A bounded, process-local queue owned by the Swarm infrastructure runtime. It contains normalized Core event batches awaiting durable ingestion. It has no business-state authority and survives neither restart nor overflow by itself.

The ring never drops its oldest entry to make room. Full capacity stops or disconnects upstream intake, lets the durable drain catch up, and resumes from the last committed Core cursor. The initial capacity follows the existing Core `EventHub` bound of 512 events; changing that capacity or making it configurable is not part of this feature.

#### Feishu Delivery Ring

A bounded, process-local, lane-aware queue owned by the Swarm outbound runtime. Each entry identifies an eligible durable outbox lane head; it does not copy or own the authoritative delivery payload or outcome. Queue membership is deduplicated by lane so a lane has at most one queued or active reference.

The ring is filled from the existing live/history-fair outbox selector and consumed by at most four delivery workers, preserving the current concurrency limit. It is bounded by the existing per-scan work budget of 100 references. Capacity is an upper bound on volatile scheduling work, not permission to claim 100 rows or send around cooldown.

The ring never overwrites unread references. Saturation stops selection until capacity returns. Dequeue does not imply eligibility: the delivery executor must atomically claim and revalidate the current durable row immediately before the Feishu call. A missing, superseded, cooled-down, already-claimed, or otherwise ineligible reference is skipped without external effect and without mutating a newer lane head.

The ring is neither persisted nor replayed. On process loss, its references disappear and pending durable rows are found by the next outbox scan. On orderly shutdown, queued-but-unstarted references return to that same rediscovery path while active deliveries retain the existing bounded drain and outcome-checkpoint rules.

#### Durable Core Event Inbox

Swarm's existing SQLite inbox remains the durable downstream boundary. Ingesting a batch deduplicates stable event IDs and advances its lane/stream cursor in one transaction. Projection acknowledgement is separate and replayable.

#### Submission Receipt

Core owns the submission lifecycle. The required states are:

- `prepared`: validation and durable intent completed before the PTY no-replay boundary;
- `uncertain`: bytes may have crossed the PTY boundary, but successful completion was not durably confirmed;
- `accepted`: text and Enter completed their Core submission boundary;
- `rejected`: Core proves the prompt did not cross the no-replay boundary.

The receipt is keyed by the caller-provided submission ID and fenced to the current terminal and session epoch. Duplicate IDs with identical immutable input return the existing receipt; conflicting reuse fails closed.

Agent-derived Human Message or turn data may later add a correlation hint, but cannot change whether submission crossed the no-replay boundary.

#### Observation Epoch

Swarm observes a managed Prompt from its accepted/uncertain submission cursor forward under the Binding generation, session epoch, and single-active-turn invariants. Native turn ID and start time remain optional evidence used for diagnostics and stronger fencing when available, not required Prompt identity.

If ordered events cannot be assigned without ambiguity, the observation becomes uncertain or needs human. It never causes automatic prompt replay or output theft from another execution.

#### Native Input Batch execution body

`NativeInputBatch` keeps its frozen display body. The dispatch claim additionally exposes an `executionBody` constructed from immutable `PromptInput` members ordered by `ordinal`. Ordinary prompts use their existing body as the execution body. Missing or duplicate membership is invalid state and blocks dispatch.

### Architecture

#### Herdr Core responsibilities

- Add a new capability, provisionally `session_event_stream_v1`.
- Add new method names for the v2 contract rather than changing the load-bearing shape of published `agent.events.*` methods.
- Open/follow a session stream using `pane_id`; resolve and validate source paths inside Core.
- Normalize JSONL-derived records and selected Core-native facts into one bounded, redacted event envelope.
- Commit durable session events and cursor movement before announcing availability through `EventHub`.
- Preserve current `EventHub` for volatile UI/runtime events; publish a lightweight stream-available event or equivalent internal notification rather than making subscribers trust its volatile sequence.
- Expose idempotent receipt lookup independently of transcript appearance.
- Preserve old `agent.events.attach/read/subscribe/locate` behavior for compatibility.

The new API contract supplies:

- stream open/identity by Pane;
- bounded read and subscribe after an opaque cursor;
- stable event ID and stream/session epoch on every event;
- earliest/latest cursor and typed cursor-expired outcome;
- submission ID on native receipt events;
- optional turn metadata where the Agent source provides it;
- content bounds and existing redaction guarantees.

Exact method/type names may follow existing Core naming conventions, but must be additive and capability-gated. A legacy server must not accept a request while silently ignoring fields needed for safety.

#### Swarm infrastructure responsibilities

- Extend the Core adapter with capability detection and the path-free stream methods.
- Replace default-mode transcript descriptor/path resolution with Pane-based stream opening.
- Add one bounded `CoreEventIngress` ring between socket reads and `CoreEventInboxStore.ingestBatch`.
- Keep one producer and one ordered durable drain per stream epoch; duplicate wake-ups may coalesce.
- Resume only from the cursor persisted by the inbox transaction, not the last cursor merely seen in memory.
- Route durable inbox events through existing reducers/projectors and the Recovery Supervisor.
- Keep the explicit legacy `jsonl` and `shadow` implementations isolated behind compatibility selection.
- Place a bounded, lane-aware Delivery Ring between durable outbox lane-head selection and `OutboundDeliveryExecutor`.
- Enqueue at most one reference per lane, preserve the existing live/history fairness, four-active-delivery limit, and 100-work-per-scan bound, and stop selecting when the ring is full.
- Keep durable claim and all external-effect fencing in `OutboundDeliveryExecutor`; ring enqueue/dequeue alone never claims, acknowledges, retries, or quarantines a row.
- Refill after completion or skipped stale work, and schedule a later scan for durable cooldown/retry work without busy-looping.
- During shutdown, stop ring intake and new sends, boundedly await/checkpoint active sends, and leave unstarted work pending in the outbox for restart recovery.

Dependency direction remains Core adapter -> normalized domain envelopes -> durable inbox -> coordinator/projector. Coordinators do not parse Core JSON, resolve paths, or read JSONL.

#### Prompt Execution responsibilities

- `PrimaryPromptDispatcher` and bootstrap `PromptTurnExecutor` submit `executionBody`.
- Submission success immediately transitions to accepted/no-replay observation using the returned receipt.
- Recovery queries receipt state and Core stream history; it does not require an exact transcript Human Message claim before reporting accepted.
- Existing per-Binding FIFO, Native Submission Slot, Active Turn Slot, generation fences, and steering rules remain enforced.

### Behavior & Failure Modes

- Core persists the no-replay state before initiating PTY submission.
- A known pre-boundary validation failure produces `rejected`; Swarm may terminalize according to existing dispatch policy.
- A timeout, disconnect, or Core crash after the no-replay state is durable produces or recovers as `uncertain`; Swarm must not resubmit.
- `accepted` is durable before the success response is relied upon. A lost response is recovered by receipt lookup.
- Core journal insertion and per-stream cursor advancement are atomic.
- Swarm inbox insertion, event-ID deduplication, and durable cursor advancement are atomic.
- Projection failure never rolls back the inbox cursor; pending inbox entries remain rediscoverable.
- EventHub wake-up loss is harmless because periodic/connection recovery reads after the durable cursor.
- Ring saturation never discards entries. Backpressure and reconnect are bounded; only one reconnect/drain loop exists per stream.
- Delivery Ring saturation never discards or overwrites durable work and never expands external delivery concurrency. Selection resumes only as capacity returns.
- A queued delivery reference is advisory until the durable claim succeeds. Claim-time revalidation preserves current lane-head, fence, retry/cooldown, idempotency, and quarantine rules.
- Delivery Ring loss on crash cannot lose an outbox row or repeat a completed external effect: pending work is rediscovered, while successful/uncertain outcomes remain governed by durable claim and checkpoint state.
- Outbound shutdown drains only already active external calls under the existing bound; it does not force queued references to send or turn them into acknowledged work.
- JSONL partial writes remain invisible until complete. Replacement/truncation becomes an explicit source transition or typed error.
- Event payloads remain bounded and redacted before Core persistence and before Swarm persistence.

### Compatibility & Migration

- Core's existing `events.subscribe` and `agent.events.*` APIs retain their current behavior.
- The new stream is advertised by capability; Swarm selects it only when advertised.
- Swarm default `events` mode prefers the v2 stream. On older Core it uses the current descriptor-based Core event path, not a guessed v2 request.
- Explicit `jsonl` and `shadow` modes remain temporary rollback tools. Their later removal requires a separate compatibility decision.
- Existing persisted `core_event_inbox` rows remain readable. Any schema extension is additive and migration-tested.
- Existing submitted/detached Prompts are never replayed during migration. Legacy rows without a v2 cursor retain conservative recovery behavior.
- Existing formatted Native Input Batch bodies remain display/audit data. No data rewrite is required because raw ordered members already exist.
- Prompt execution domain documentation must stop defining exact turn identity as the required submission ownership relation. Exact turn evidence remains optional observation metadata and a safety fence where present.

## Testing Decisions

### Core public seams

- API schema/CLI tests prove path-free open and capability negotiation without changing legacy method shapes.
- Event service tests prove JSONL and Core-native events share one stream order and stable deduplication.
- Journal tests cover restart, partial record, source replacement, retention, cursor expiry, and historical reads.
- Submission tests cover accepted, deterministic rejection, response loss, crash/closure during PTY submission, duplicate ID, and conflicting reuse.
- EventHub tests prove existing 512-entry behavior remains intact and stream wake-ups cannot replace durable cursor reads.
- Redaction and maximum-frame tests cover all new envelopes.

### Swarm public seams

- Adapter/reader tests prove v2 capability selection, Pane-only opening, reconnect after disconnect, cursor-expired handling, and absence of transcript paths.
- Ingestion tests use a bounded fake ring to prove ordering, backpressure, no overwrite, duplicate batches, crash before inbox commit, and crash after inbox commit.
- Outbound drain tests use a bounded fake Delivery Ring to prove capacity backpressure, at-most-one queued/active reference per lane, four-worker concurrency, 100-work scan bounds, and preserved live/history fairness.
- Delivery executor/store integration tests prove claim occurs only at send time, stale queued references cannot bypass lane/fence/cooldown state, and retries or uncertain external effects retain their current durable checkpoint behavior.
- Restart and shutdown tests prove queued volatile references are rediscovered from the outbox, active sends are boundedly drained/checkpointed, and no queued-only reference is lost, acknowledged, or replayed as a duplicate Feishu effect.
- Store tests prove event and cursor atomicity across reopen.
- Dispatcher tests prove accepted/uncertain receipt handling without exact turn identity and preserve no-replay.
- Recovery tests prove ordered best-effort observation, optional turn enrichment, direct-Human ambiguity, and `needs_human` precedence.
- Native batch store and dispatcher tests prove raw one/two/three-member execution bodies, reopen behavior, missing-member refusal, and preservation of literal marker-like user text.
- Composition and architecture tests prove the default v2 path does not import transcript locators/readers and that legacy modes remain isolated.
- Existing projection, delivery, readiness, and restart-safety tests remain green.

### Cross-repository contract

- Freeze representative v2 capability, stream-open, batch, cursor-expired, and receipt payload fixtures in both repositories.
- Run a built Core binary against the Swarm adapter for at least: live accepted submission, disconnect/reconnect, duplicate delivery, and session replacement.
- Verify a legacy Core selects only the configured compatibility path.

## Out of Scope

- Modifying Agent-owned JSONL files or requiring Agents to emit a new format.
- Persisting every UI `EventHub` event in the Agent journal.
- Treating the Swarm ring buffer as durable or authoritative.
- Treating the Feishu Delivery Ring as a durable queue, copying outbox authority into it, or increasing Feishu delivery concurrency beyond the existing limit.
- Automatically replaying uncertain submissions.
- Deleting legacy `jsonl`/`shadow` modes in the same migration.
- Installing, restarting, deploying, pushing, opening a pull request, or merging either repository.
- Repairing unrelated Core `master` worktree changes.

## Further Notes

### Workspace

- Swarm isolated worktree: `/workspace/herdr-agent-swarm/.trae/worktrees/unified-session-events`
  - branch: `worktree-unified-session-events`
  - starting revision: `e5fb6f11dba0340032ed1ca35465e685ea809799`
  - created with the Host worktree mechanism and fast-forwarded from its default base to the current local `main`.
- Core isolated worktree: `/tmp/herdr-core-unified-session-events`
  - branch: `feat/unified-session-events`
  - starting revision: `dc666042e74a4a655145b706a63746d81a57b070`
  - created with Git fallback because the Host worktree session can manage only the active Swarm repository.

The original Swarm checkout contains user-owned `TODO.md` and untracked research/worktree files. The original Core checkout contains 16 modified files, including overlapping Agent event work. None were copied, stashed, reset, or edited. The Core implementation may inspect that diff as evidence but must not import it wholesale or claim ownership of it.

### Baseline evidence

- Swarm `npm ci`: passed; npm reported one existing high-severity dependency advisory.
- Swarm `npm run typecheck`: passed.
- Swarm `npm run build`: passed and generated build identity `sha256:30c79f03587c0bf1a590f6c4bc2f3c27d6f4c3b16b80bf427495129739a596eb`.
- Swarm full Vitest run after build: 530 suites and 3,561 tests passed, zero failed.
- Core Linux `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, 3,374 nextest tests, 101 maintenance tests, 6 UI architecture tests, and 29 integration-asset tests passed with inherited Herdr runtime variables removed and Zig 0.15.2 using a writable temporary cache.
- Core documentation contract: 7 tests passed.
- Core `just check` Windows cross-lint could not compile bundled SQLite on this Linux host because the MSVC C toolchain/standard headers are unavailable (`lib.exe` initially missing; the local Zig fallback then lacked `stdlib.h`). This is an environment limitation after all native checks passed, not a source failure. The user approved continuing after this limitation was reported. Windows cross-lint remains required before final delivery if a compatible toolchain becomes available; otherwise it must be reported explicitly.

Gate 1 design and this Gate 2 specification were approved on 2026-10-02. Gate 3 ticket approval and implementation authorization remain pending. No implementation, install, restart, push, PR, deployment, or main-branch merge is authorized by this document.
