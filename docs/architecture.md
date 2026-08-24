# Herdr Lark Bridge Architecture

## Who this is for

This document is for an engineer taking ownership of the bridge or diagnosing a
production session. After reading it, they should be able to identify the
authority for any observed state and follow a request from Lark through Herdr
and back to a durable Lark delivery.

## System purpose

Herdr Lark Bridge connects a Lark topic to one TraeX process in a real Herdr
pane. It lets a person start work, queue later requests, and see a safe terminal
stream in Lark while preserving Herdr as the place for local observation and
high-risk approval.

The bridge is a durable workflow coordinator, not a message relay. It does not
assume that a Lark API call, a terminal read, or a plugin event is a complete
transaction by itself.

## Ownership and authority

| Concern | Authority | Why |
| --- | --- | --- |
| Pane identity, terminal identity, agent state, foreground process | Herdr snapshot and targeted runtime observation | Herdr owns panes and the TraeX process. |
| Binding lifecycle, prompt queue, delivery intent, retry state, audit, lease | SQLite | These facts must survive a bridge restart. |
| Visible cards and messages | Lark | Lark is the external delivery target, not the source of workflow truth. |
| Process lifecycle | user systemd service | The plugin controls the service; the application does not manage PID files. |
| Plugin events | bounded wake-up hints | Events improve latency but do not create a second event log. |

When these sources disagree, do not repair SQLite from a Lark card or infer a
pane state from a card. Reconcile against Herdr, then let the normal projection
and durable Lark outbox converge the visible state.

## Architecture and dependency direction

The architecture follows a ports-and-adapters structure. Dependencies
point inward: the domain defines the language and ports required by use cases;
application workflows depend on those ports; infrastructure implements them for
SQLite, Herdr, Lark, and the host runtime. A concrete adapter must not become
the source of workflow policy.

```text
┌──────────────────────────── External systems ────────────────────────────┐
│ Lark / CardKit                Herdr / TraeX                 user systemd │
└──────────────┬──────────────────────┬───────────────────────────┬────────┘
               │ SDK / HTTP           │ CLI / snapshot            │ lifecycle
               v                      v                           v
┌──────────────────────── Infrastructure and adapters ─────────────────────┐
│ Lark adapter · Herdr adapter · command runner · UDP event inbox           │
│ SQLite store · in-process event dispatch · health server · lease runtime  │
└───────────────────────┬──────────────────────────────────────────────────┘
                        │ implements ports
                        v
┌────────────────────────── Application workflows ─────────────────────────┐
│ Inbound routing and prompt acceptance · prompt run · runtime reconciliation│
│ binding provisioning · operations · conversation projection · outbox drain │
│                                                                            │
│ Workflows coordinate use cases and request atomic port operations. They do │
│ not embed Lark SDK calls, Herdr CLI parsing, or SQLite-specific policy.    │
└───────────────────────┬──────────────────────────────────────────────────┘
                        │ depends on domain contracts
                        v
┌──────────────────────────────── Domain ──────────────────────────────────┐
│ Binding and Prompt entities; Turn and Steering execution concepts;        │
│ state transitions; FIFO,                                                   │
│ uncertain-dispatch, and approval invariants; lifecycle event types;        │
│ capability-focused ports.                                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

The composition root creates all concrete workflows and infrastructure adapters,
then injects capability-focused ports into `InboundRouter` and the workflows.
Runtime modules do not read plugin paths or process-manager state directly.

### Current implementation map

The implementation uses the following workflow decomposition.

| Implementation | Responsibility | Boundary |
| --- | --- | --- |
| `InboundRouter` | Durable ingress, command routing, prompt acceptance, and application lifecycle wiring | Inbound application boundary |
| `PromptRunWorkflow` | FIFO turn draining, steering, detached observation, durable safety scans, `TurnSupervisor`, and prompt-specific shutdown | Prompt execution boundary |
| `BindingProvisioningWorkflow` | Project selection, pane creation/discovery, attach, reset, replace, and interrupted provisioning recovery | Provisioning boundary |
| `OperationsWorkflow` | Close, archive/resume, rename/model, operator views, and dead-letter actions | Operator-command boundary |
| `StartupViewConverger` | Deterministic startup repair of topic/run-card projections and missing Answer-card intent | Startup recovery boundary |
| `InProcessPromptWorkScheduler` | Coalesced process-local binding and detached-prompt wake-ups behind `PromptWorkScheduler` | Best-effort scheduling adapter |
| `HerdrRuntimeReconciler` | Herdr snapshot convergence and runtime-change-triggered prompt scheduling hints | Runtime authority boundary |
| `BridgeEventBus` | Lifecycle projection events behind `LifecycleEventPublisher`; inbound work uses a separate notifier | Process-local lifecycle adapter |
| `ConversationViewProjector` | Run-card and topic-view reduction plus outbound intent creation | Projection boundary |
| `OutboundIntentWriter` | Target validation, durable outbox writes, and best-effort outbound wake-up | Delivery-intent boundary |
| `LarkOutboxDispatcher` | Background Lark delivery, retry, dead letters, safety scans, and Answer-card-ready callbacks | Delivery boundary |
| Capability store ports | Consumer-specific atomic persistence capabilities | Application persistence boundary |
| `SqliteBindingStore` | One transactional implementation of the capability-focused store ports | Durable infrastructure boundary |

### Ubiquitous language and module names

Use domain terms for business concepts and workflow terms for application use
cases. Do not name a module after its current technical mechanism when its
responsibility is a business or application concern.

| Superseded or broad term | Current term | Meaning |
| --- | --- | --- |
| `Binding` | `TopicPaneBinding` in explanatory and external-facing contexts | The controlled association between a Lark topic or root message and a Herdr pane. `Binding` remains an acceptable short internal domain term. |
| `SyncCoordinator` | `InboundRouter` | Routes normalized Lark input to application commands; it does not own execution, reconciliation, or delivery. |
| prompt execution | `PromptRunWorkflow` | Owns FIFO turn draining, steering, detached observation, SQLite-backed safety scans, `TurnSupervisor`, and prompt-specific shutdown behavior. |
| `SessionReconciler` | `HerdrRuntimeReconciler` | Converges the authoritative Herdr pane and agent runtime into durable binding state. |
| workflow wake-up adapter | `PromptWorkScheduler` | A coalescing, best-effort scheduler that asks the prompt-run workflow to reload and claim durable work. |
| concrete `BridgeEventBus` dependency | `LifecycleEventPublisher` | Application workflows publish lifecycle outcomes through this port. Inbound messages use `InboundWorkNotifier`, a separate contract. |
| `CardProjector` | `ConversationViewProjector` | Reduces lifecycle outcomes into topic and run-card read models, then records delivery intent. |
| `LarkChannelPublisher` | `OutboundIntentWriter` and `LarkOutboxDispatcher` | The writer records durable intent without network I/O; the dispatcher delivers it with ordering, retries, and dead-letter handling. |
| prompt-run persistence | `PromptRunStore` | The prompt-run workflow's capability-focused persistence interface. |
| `BindingStorePort` as a consumer dependency | capability-focused stores | Consumers use `InboundStore`, `PromptAcceptanceStore`, `PromptRunStore`, `RuntimeReconciliationStore`, `ProjectionStore`, `OutboxStore`, `BindingProvisioningStore`, `OperationsStore`, `LeaseStore`, or `HealthStore`. The aggregate interface remains only as the SQLite implementation contract and source for the capability types. |

`RunCardView`, `TopicViewState`, and Answer-page state are projections or read
models. They are not domain entities alongside `Binding` and `Prompt`, nor are
they execution concepts like `Turn` and `Steering`. Their renderers and reducers
belong to the presentation and projection side of the application, while
durable storage for them remains an infrastructure concern.

### Ports and persistence

Ports belong to the core-facing boundary and describe a consumer's capability,
not a database table or SDK. Prompt acceptance, prompt execution, projection,
outbound delivery, binding provisioning, operations, and lease ownership each
depend only on the operations they use. SQLite can implement several such ports
through one concrete store and one transaction.

SQLite is infrastructure, but it is the durable authority for workflow facts:
bindings, inbound acceptance, FIFO queue order, dispatch checkpoints, detached
observation, card projections, outbox intent, audit data, and the fenced
instance lease. Atomic acceptance and claim transitions must remain atomic when
ports are narrowed; splitting a large store interface must not split a workflow
transaction.

Herdr and Lark are external systems behind ports. Herdr observations establish
the live pane and TraeX state; Lark receives visible messages and cards. Neither
adapter defines business-state transitions, and no workflow may infer durable
truth from a Lark card.

### Events and scheduling

The design uses two different event roles. They may share small in-process
publish/subscribe mechanics, but must remain separate contracts and must not be
treated as two sources of persistent state.

| Role | Meaning | Consumer behavior | Reliability boundary |
| --- | --- | --- | --- |
| Domain lifecycle event | A description of a business outcome, such as `PromptQueued`, `TurnStarted`, `TurnCompleted`, or a binding state change. | Project deterministic run-card and topic views, then record outbound intent. | Process-local notification. Durable aggregate and projection state remain authoritative; startup convergence repairs persisted views and delivery intent. |
| Workflow wake-up | A bounded hint that a scoped binding or detached prompt may now have executable work. | Reload SQLite facts and atomically claim eligible work. | Best effort only: duplicate, reordered, or lost hints are safe because startup and periodic reconciliation scan durable work. |

A wake-up is not a domain event and does not carry prompt text or authoritative
workflow state. `InProcessPromptWorkScheduler` implements `PromptWorkScheduler`
as a coalescing latency hint. A domain lifecycle event, published through
`LifecycleEventPublisher`, must not be used as a worker command merely because
it was observed by a projector.

Every workflow-wake-up producer follows the durable-before-wake rule:

1. Commit the SQLite state transition.
2. Publish the scoped wake-up.
3. Return without assuming delivery of that wake-up.

An in-process event dispatcher is infrastructure, not storage. The SQLite
outbox is the durable delivery mechanism for Lark work. If a future requirement
needs reliable cross-process event consumption, it requires a separately
designed durable dispatcher or transactional event outbox; an in-memory bus
cannot provide that guarantee.

Lifecycle projection has a deliberately narrower guarantee than event sourcing.
Prompt acceptance commits the job, initial run-card, and Answer-card outbox intent
atomically. Terminal turn, failure, and steering outcomes commit prompt state and
their durable run-card/topic projections atomically before publishing a lifecycle
notification. Binding transitions with an existing status card can commit the
transition, topic projection, and update intent together. Startup convergence
repairs Answer-card intent and re-mirrors persisted run-card state into the topic
view. Transient terminal-output snapshots remain replaceable projections.

`lifecycle_events` is an audit aid, not a complete replay log. The recovery
contract is persisted workflow state plus deterministic convergence, not replay
of every process-local notification. This is separate from workflow wake-ups:
wake-ups remain best effort because workers always reload durable state.

Lifecycle subscribers are isolated from workflow publishers. The event bus waits
for every subscriber present at publication time, but records and logs an
individual subscriber failure instead of rejecting the workflow publication.
This prevents a projection failure from reclassifying a workflow result that is
already durable. `/status` exposes the process-local failure count and latest
failed subscriber; these diagnostics reset on restart and do not affect
readiness.

### Runtime shape

```text
Lark message or card action                  Herdr plugin event
             |                                       |
             v                                       v
   InboundRouter and durable acceptance         UDP wake-up hint
             |                                       |
             +----------> application workflows <---+
                              |             |
                              |             +--> HerdrRuntimeReconciler
                              |                    -> authoritative snapshot
                              v
                   PromptRunWorkflow
                   FIFO turn / steering / observer
                              |
                              v
                     Herdr port -> TraeX
                              |
                 durable lifecycle result
                              |
                              v
                    lifecycle event -> projection
                              |
                              v
                    SQLite outbox -> Lark port
```

## Request lifecycle

1. The Lark adapter normalizes an incoming message or card action.
2. `InboundRouter` rejects messages outside the configured chat and bridge-owned
   messages, then durably records the rest before attempting business handling.
3. A command is handled as a binding or operational workflow. Ordinary text in
   an active bound topic becomes a prompt job. A message received during an
   active turn may become steering when the runtime confirms that steering is
   safe. Exact, case-insensitive `/stop` is a priority steering command only
   while the supervised turn is explicitly `working`: it bypasses queued
   ordinary prompts without cancelling or reordering them. In every other
   state, including a race where the turn stops before injection, it is rejected
   and never falls back to the ordinary FIFO.
4. After durable acceptance, `InboundRouter` publishes a process-local wake-up.
   `PromptRunWorkflow` reloads SQLite state and a per-binding worker claims
   one dispatchable job. The user text is sent to
   Herdr unchanged; the bridge adds no hidden prompt suffix.
5. Herdr runs or observes TraeX. Structured state is preferred; terminal and
   process evidence provide bounded fallbacks where Herdr reports `unknown`.
6. The responsible workflow publishes process-local lifecycle events.
   `ConversationViewProjector` materializes run-card and topic views, then records
   Lark work in the outbox.
   The outbox is durable; full lifecycle-event replay is not yet available.
7. `LarkOutboxDispatcher` delivers outbox work, retaining retries and dead
   letters. A delivery failure never repeats a submitted TraeX prompt.

Interrupted running prompts are detached instead of replayed. On restart the
bridge observes the surviving pane and resumes delivery or marks the situation
explicitly uncertain. Jobs that never started remain queued.

## Reconciliation and events

Herdr plugin hooks send a small loopback datagram containing only bounded event
metadata. The event receiver coalesces bursts and requests reconciliation for
the affected workspaces. It does not mutate bindings from the hook payload.

`HerdrRuntimeReconciler` is the sole convergence path for event-driven and
periodic recovery:

1. Read one current Herdr snapshot when available, with a compatibility fallback
   for older Herdr installations.
2. Restrict the result to configured workspaces.
3. Detect missing panes, terminal identity changes, unknown agent states, and
   eligible unbound TraeX panes.
4. Read bounded terminal output only where it is needed.
5. Update binding state, publish lifecycle events, and emit targeted wakes when
   an observed runtime change can unblock prompt work.

Periodic reconciliation remains required. A missed UDP datagram may delay an
update, but must not change the final converged state.

The same rule applies to `PromptWorkScheduler` hints. Prompt acceptance,
Answer-card delivery checkpoints, and reconciliation persist their state before
publishing a scoped wake-up. Wake-ups are coalesced and may be duplicated,
reordered, or lost. Workers atomically claim current SQLite work.
`PromptRunWorkflow` performs startup and periodic SQLite-only safety scans for
queued turns, eligible steering, and detached observers, so prompt convergence
does not depend on a successful Herdr snapshot. Scan hints prioritize detached
observation before steering and ordinary FIFO work for the same binding.
`BridgeEventBus` remains separate: it carries lifecycle events to deterministic
card projections, not commands to execute work.

## Answer streaming and pagination

Every new ordinary prompt owns an Answer CardKit entity. Its fixed Markdown
element is updated through CardKit streaming rather than by repeatedly replacing
the whole Lark message. The original Lark message remains the request record.

Terminal observations are normalized before persistence or delivery. ANSI and
terminal chrome, prompt echo, reasoning blocks, internal protocol markup, and
secret values are removed or redacted. Overlapping terminal windows append only
new visible material. When a terminal redraw has no reliable overlap, the active
transient terminal view is replaced with the new safe screen (`replace-all`),
which prevents an entire redrawn terminal from being appended twice. Final
TraeX answers then converge the card to the completed result.

Each run-card stores the active Answer page: its Lark message ID, CardKit ID,
element ID, source start offset, page index, and sequence. When content reaches
the safe CardKit size, the bridge finishes the active page, creates a
continuation card with a stable page idempotency key, and makes that page active.
Frozen pages are never patched again. Markdown fences are closed and reopened
only in the render copy; the persisted Answer remains canonical source text.

The current implementation keeps the active page in the run-card projection and
uses durable outbox records as the history of creation and delivery. It does not
yet have a separate `answer_pages` table.

## Lark delivery

All user-visible replies are first represented as SQLite outbox rows with stable
idempotency keys. `OutboundIntentWriter` persists each intent before publishing
a payload-free, best-effort wake-up and does not wait for Lark.
`LarkOutboxDispatcher` delivers card replies, card updates,
streaming card creation, stream content, and stream finalization. It marks
successful rows delivered; transient failures are retried with backoff; repeated
failures become dead letters that an operator can retry or dismiss.
It performs an initial scan and a periodic safety scan, so lost or duplicate
wake-ups cannot change the converged result.

The sanitized `/status` view combines two deliberately different signals.
SQLite reports durable lane-head counts, currently eligible heads, the earliest
future retry, and oldest-head age. The dispatcher reports only bounded
process-local scan and delivery timestamps, outcome, active delivery count, and
whether a scan is pending. These diagnostics contain no lane or message
identifiers and reset when the process restarts; they never become workflow
authority.

Order is important inside one CardKit element because sequences must increase.
The dispatcher assigns every outbox row a durable delivery order and drains only
the head of each target lane. Work is serial within a lane, including retries,
while up to four independent lanes may make progress concurrently. A failed or
future-due head blocks only its own lane. Lark requests use a dedicated bounded
timeout; HTTP 429 responses honor a bounded `Retry-After`, and other transient
failures use jittered exponential backoff.

## Process lifecycle and diagnostics

The supported production owner is a user systemd service installed and operated
through Herdr plugin actions. The application also holds a fenced SQLite lease,
which protects against accidental duplicate processes sharing one database.

Health endpoints have separate meanings:

- `/health` means the process can answer requests.
- `/ready` additionally requires the lease, configured project paths, Herdr,
  and Lark to be usable.
- `/status` returns a sanitized operational snapshot even when dependencies are
  degraded. It includes process-local prompt-worker scan outcome, discovered
  work counts, failure time, and active worker counts without identifiers.

Shutdown stops ingress, waits for known work, and detaches observers if the
grace period expires. It does not replay work or delete user state. Logs and
status deliberately exclude prompt bodies, raw terminal output, card payloads,
and credentials.

## Safety rules

- Lark may not approve a high-risk TraeX action. Approval remains in Herdr.
- `/stop` is TraeX steering, not a remote process or pane kill. It cannot bypass
  approval, and it is never queued when no `working` turn can accept it.
- A prompt is never automatically replayed after uncertain dispatch or restart.
- Pane attachment and replacement validate workspace, project directory, and
  terminal identity before changing a binding.
- Plugin events and Lark cards are not trusted business-state sources.
- Runtime SQLite files are service-owned data and are never version-controlled.

## Current evolution priorities

1. Preserve the implemented startup and periodic SQLite safety scans as the
   correctness mechanism behind the best-effort `PromptWorkScheduler`; wake-ups
   remain latency hints only.
2. Keep user-visible terminal transitions atomic and transient output projections
   reconstructible; `BridgeEventBus` is not a replay log.
3. Extend capability ports instead of reintroducing broad store dependencies.
4. Preserve the implemented persisted outbox lane and dispatcher diagnostics
   while maintaining strict in-lane ordering.
5. Model Answer pages explicitly only when page-level recovery, audit, or
   operations need more than the active page and outbox history.

## Implemented guarantees and verification

The durable workflow-module migration is complete. The following matrix is the
maintenance checklist for changes that cross workflow, persistence, or delivery
boundaries. The named tests are examples of executable evidence, not substitutes
for the full suite.

| Guarantee | Implementation evidence | Verification evidence |
| --- | --- | --- |
| Durable acceptance precedes execution | `InboundRouter` records inbound work and `acceptPrompt` atomically writes the prompt, initial run-card, and Answer-card intent before a scheduler hint. A turn claim also requires the Answer card delivery checkpoint. | SQLite store tests and concurrency-control integration tests |
| At most one ordinary turn per binding | `PromptRunWorkflow` uses one worker per binding; the store atomically claims the oldest eligible FIFO prompt only when no prompt is running. | Concurrency-control and steering integration tests |
| Uncertain dispatch is never replayed | Dispatch checkpoints distinguish not-started from possibly dispatched work. Shutdown and restart detach the observer; detached recovery observes the existing Herdr turn. | SQLite recovery, prompt workflow, and shutdown tests |
| Terminal state survives missed lifecycle notification | Turn completion, turn failure, and steering completion update prompt state and durable run-card/topic projections in one SQLite transaction. Startup convergence repairs delivery intent from those views. | Terminal-projection SQLite tests and event/card integration tests |
| Wake-up loss affects latency only | `PromptWorkScheduler` carries identity-only hints; `PromptRunWorkflow` independently scans durable queued, steering, and detached work without requiring Herdr reconciliation. | Prompt safety-scan, scheduler, SQLite recovery, and runtime reconciler tests |
| Herdr identity remains authoritative | Provisioning, live operations, and reconciliation check workspace, project directory, pane identity, and terminal identity before state-changing effects. | Attach, provisioning recovery, pane-close, model, and reconciler tests |
| Lark retries cannot repeat TraeX work | All Lark work is persisted in the outbox. `LarkOutboxDispatcher` alone claims delivery work, and dead-letter retry changes only outbox state. | Outbox dispatcher and SQLite dead-letter tests |
| Delivery order is isolated by lane | Every outbox row stores a deterministic `lane_key`; only each lane head is claimable, while independent lanes can drain concurrently. | SQLite migration and outbox dispatcher tests |
| Store dependencies remain capability-focused | Application, runtime, health, projection, and delivery consumers accept named capability ports. `BindingStorePort` remains only the aggregate contract implemented by SQLite and the source of those `Pick`-based types. | TypeScript typecheck plus source-boundary audit |
| Operational defaults and display stay safe | `TRAEX_PERMISSION_MODE` defaults to `auto`; provisioned panes use short generated names; cards render `space / pane_name`; high-risk approval remains local to Herdr. | Configuration, discovery, title, and card rendering tests |

The final migration checkpoint requires the full Vitest suite, TypeScript
typecheck, production build, whitespace validation, and the non-mutating
real-user status smoke. The smoke proves service observability and configured
dependency access; its manual Lark confirmation flag does not prove a new live
message or card action unless an operator explicitly performs one.

## Related documents

- [Feishu group usage](feishu-group-usage.md) explains user commands and safety
  behavior.
- Historical design and iteration records live in
  [archive/](archive/), including [archive/designs](archive/designs/) and
  [archive/superpowers](archive/superpowers/).
