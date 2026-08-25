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

The target architecture follows a ports-and-adapters structure. Dependencies
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
│ Inbound routing and prompt acceptance · prompt run · runtime reconciliation
│ binding provisioning · operations · conversation projection · outbox drain
│                                                                            │
│ Workflows coordinate use cases and request atomic port operations. They do │
│ not embed Lark SDK calls, Herdr CLI parsing, or SQLite-specific policy.    │
└───────────────────────┬──────────────────────────────────────────────────┘
                        │ depends on domain contracts
                        v
┌──────────────────────────────── Domain ──────────────────────────────────┐
│ Binding and Prompt entities; Turn and Steering execution concepts; state │
│ transitions; FIFO, uncertain-dispatch, and approval invariants;          │
│ lifecycle event types; capability-focused ports.                         │
└──────────────────────────────────────────────────────────────────────────┘
```

The composition root already creates the concrete infrastructure adapters. The
remaining migration is to inject narrower port interfaces into extracted
application workflows. Runtime modules do not read plugin paths or
process-manager state directly.

### Current implementation map

The production implementation has not completed the target decomposition. Use
the following names when tracing the current code and the target names when
designing the next boundary.

| Current implementation | Current responsibility | Target boundary |
| --- | --- | --- |
| `SyncCoordinator` | Inbound routing, prompt acceptance and execution, binding provisioning, operations, and recovery wiring | `InboundRouter` plus separate application workflows |
| `SessionReconciler` | Herdr snapshot convergence and queue scheduling callbacks | `HerdrRuntimeReconciler` publishing scoped work hints |
| `BridgeEventBus` | Lifecycle projection events and durable-inbound notifications | Separate `LifecycleEventPublisher` contract; inbound dispatch remains a different contract |
| `CardProjector` | Run-card and topic-view reduction plus outbound intent creation | `ConversationViewProjector` |
| `LarkChannelPublisher` | Durable Lark outbox draining, retry, dead letters, and Answer-card-ready callbacks | `LarkOutboxDispatcher` publishing delivery checkpoints to the scheduler |
| `BindingStorePort` / `SqliteBindingStore` | Broad persistence surface and atomic transitions | Capability-focused ports implemented by one transactional SQLite store |

### Ubiquitous language and target module names

Use domain terms for business concepts and workflow terms for application use
cases. Do not name a module after its current technical mechanism when its
responsibility is a business or application concern.

| Current or broad term | Target term | Meaning |
| --- | --- | --- |
| `Binding` | `TopicPaneBinding` in explanatory and external-facing contexts | The controlled association between a Lark topic or root message and a Herdr pane. `Binding` remains an acceptable short internal domain term. |
| `SyncCoordinator` | `InboundRouter` after responsibilities are extracted | Routes normalized Lark input to application commands; it is not the long-term owner of execution, reconciliation, or delivery. |
| prompt execution | `PromptRunWorkflow` | Owns FIFO turn draining, steering, detached observation, `TurnSupervisor`, and prompt-specific shutdown behavior. |
| `SessionReconciler` | `HerdrRuntimeReconciler` | Converges the authoritative Herdr pane and agent runtime into durable binding state. |
| workflow wake-up bus | `PromptWorkScheduler` | A coalescing, best-effort scheduler that asks the prompt-run workflow to reload and claim durable work. |
| `BridgeEventBus` | `LifecycleEventPublisher` | Distributes lifecycle outcomes to projections. Before this rename, its inbound-message channel must be split into a separate ingress contract. |
| `CardProjector` | `ConversationViewProjector` | Reduces lifecycle outcomes into topic and run-card read models, then records delivery intent. |
| `LarkChannelPublisher` | `LarkOutboxDispatcher` | Drains durable outbox work to Lark with ordering, retries, and dead-letter handling. |
| `BindingStorePort` | capability-focused stores | Replace the broad port incrementally with `PromptAcceptanceStore`, `PromptRunStore`, `ProjectionStore`, `OutboxStore`, `BindingProvisioningStore`, `OperationsStore`, and `LeaseStore`. |

`RunCardView`, `TopicViewState`, and Answer-page state are projections or read
models. They are not domain entities alongside `Binding` and `Prompt`, nor are
they execution concepts like `Turn` and `Steering`. Their renderers and reducers
belong to the presentation and projection side of the application, while
durable storage for them remains an infrastructure concern.

### Ports and persistence

Ports belong to the core-facing boundary and describe a consumer's capability,
not a database table or SDK. For example, prompt acceptance, prompt execution,
projection, outbound delivery, binding provisioning, operations, and lease
ownership should each depend only on the operations they use. SQLite can
implement several such ports through one concrete store and one transaction.

SQLite is infrastructure, but it is the durable authority for workflow facts:
bindings, inbound acceptance, FIFO queue order, dispatch checkpoints, detached
observation, card projections, outbox intent, audit data, and the fenced
instance lease. Atomic acceptance and claim transitions must remain atomic
when ports are narrowed; splitting a large store interface must not split a
workflow transaction.

Herdr and Lark are external systems behind ports. Herdr observations establish
the live pane and TraeX state; Lark receives visible messages and cards. Neither
adapter defines business-state transitions, and no workflow may infer durable
truth from a Lark card.

### Events and scheduling

The design uses two different event *roles*. They may share small in-process
publish/subscribe mechanics, but must remain separate contracts and must not
be treated as two sources of persistent state.

| Role | Meaning | Consumer behavior | Reliability boundary |
| --- | --- | --- | --- |
| Domain lifecycle event | A description of a business outcome, such as `PromptQueued`, `TurnStarted`, `TurnCompleted`, or a binding state change. | Project deterministic run-card and topic views, then record any outbound intent. | Currently process-local for most paths. Durable aggregate state is authoritative, but not every missed projection can yet be reconstructed automatically. |
| Workflow wake-up | A bounded hint that a scoped binding or detached prompt may now have executable work. | Reload SQLite facts and atomically claim eligible work. | Best effort only: duplicate, reordered, or lost hints are safe because startup and periodic reconciliation scan durable work. |

A wake-up is not a domain event and does not carry prompt text or authoritative
workflow state. It is an application scheduling mechanism, provided by
`PromptWorkScheduler`, and is conceptually closer to `wakeBinding(bindingId)`
than to a business event. A domain lifecycle event, published through
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

Lifecycle projection has a narrower guarantee today. Some binding transitions
persist the transition, lifecycle event, topic view, and outbox intent in one
transaction. Most prompt lifecycle paths update durable prompt or binding state
and then publish an in-process event that updates `RunCardView`, `TopicViewState`,
and the outbox. A crash between those steps can leave a stale projection even
though the underlying prompt state is correct. Until projection rebuilding or a
transactional lifecycle-event path covers every transition, do not treat
`lifecycle_events` as a complete replay log.

The target contract is that every user-visible lifecycle transition is either
projected transactionally with its durable state change or reconstructible from
persisted aggregate state. This is separate from workflow wake-ups: wake-ups may
remain best effort because workers always reload durable state.

### Target runtime shape

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

This section describes current externally observable behavior. Module names may
change during the target decomposition without changing these steps.

1. The Lark adapter normalizes an incoming message or card action.
2. The coordinator rejects messages outside the configured chat and bridge-owned
   messages, then durably records the rest before attempting business handling.
3. A command is handled as a binding or operational workflow. Ordinary text in
   an active bound topic becomes a prompt job. A message received during an
   active turn may become steering when the runtime confirms that steering is
   safe. Exact, case-insensitive `/stop` is a priority steering command only
   while the supervised turn is explicitly `working`: it bypasses queued
   ordinary prompts without cancelling or reordering them. In every other
   state, including a race where the turn stops before injection, it is rejected
   and never falls back to the ordinary FIFO.
4. A per-binding worker claims one dispatchable job. The user text is sent to
   Herdr unchanged; the bridge adds no hidden prompt suffix.
5. Herdr runs or observes TraeX. Structured state is preferred; terminal and
   process evidence provide bounded fallbacks where Herdr reports `unknown`.
6. The coordinator publishes process-local lifecycle events. Card projection
   materializes run-card and topic views, then records Lark work in the outbox.
   The outbox is durable; full lifecycle-event replay is not yet available.
7. The publisher delivers outbox work, retaining retries and dead letters. A
   delivery failure never repeats a submitted TraeX prompt.

Interrupted running prompts are detached instead of replayed. On restart the
bridge observes the surviving pane and resumes delivery or marks the situation
explicitly uncertain. Jobs that never started remain queued.

## Reconciliation and events

Herdr plugin hooks send a small loopback datagram containing only bounded event
metadata. The event receiver coalesces bursts and requests reconciliation for
the affected workspaces. It does not mutate bindings from the hook payload.

`SessionReconciler` is the sole convergence path for event-driven and periodic
recovery:

1. Read one current Herdr snapshot when available, with a compatibility fallback
   for older Herdr installations.
2. Restrict the result to configured workspaces.
3. Detect missing panes, terminal identity changes, unknown agent states, and
   eligible unbound TraeX panes.
4. Read bounded terminal output only where it is needed.
5. Update binding state, publish lifecycle events, and wake eligible queues.

The event-driven reconciliation request is scoped to affected workspaces, but
the current implementation still performs a conservative reschedule for every
active binding at the end of each reconciliation pass. Eligible-only wake-up
through `PromptWorkScheduler` remains a target boundary, not a completed
implementation detail.

Periodic reconciliation remains required. A missed UDP datagram may delay an
update, but must not change the final converged state.

## Answer streaming and pagination

Every new prompt, including steering prompts, owns an Answer CardKit entity and
run-card entry. Ordinary prompts and steering prompts differ in execution and
final-content semantics, not in whether delivery state exists. Its fixed
Markdown element is updated through CardKit streaming rather than by repeatedly
replacing the whole Lark message. The original Lark message remains the request
record.

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
idempotency keys. The publisher delivers card replies, card updates, streaming
card creation, stream content, and stream finalization. It marks successful rows
delivered; transient failures are retried with backoff; repeated failures become
dead letters that an operator can retry or dismiss.

Order is important inside one CardKit element because sequences must increase.
The publisher assigns every outbox row a durable delivery order and drains only
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
  degraded.

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

## Known implementation gaps

These are concrete correctness or robustness gaps in the current implementation,
distinct from the architectural evolution priorities above. They do not require a
boundary change to fix.

- **Event bus listener isolation**: `BridgeEventBus.publish` uses
  `Promise.all` over listeners. A single listener rejection rejects the entire
  publish call. This is safe with a single subscriber today, but additional
  subscribers (metrics, audit) need per-listener error isolation before they can
  be added safely.
- **Synthetic local-detection prompt IDs**: when `SessionReconciler` detects a
  locally-completed turn through output diffing, it synthesizes a
  `` `local:${fingerprint}` `` prompt ID that does not correspond to a real
  `prompt_jobs` row. Downstream code that loads prompts or run cards by that ID
  must treat it as a terminal-output-only observation, not a prompt lifecycle
  event.
- **Pane ID to workspace ID derivation**: `WorkspaceSnapshotCache` derives
  `workspaceId` with `paneId.split(":", 1)[0]`, assuming the composite
  `workspaceId:paneId` format. The `HerdrPort` should expose workspace identity
  as a structured field instead of requiring callers to parse a composite string.
- **Terminal heuristics**: agent state detection relies on regex matching against
  terminal output patterns and poll-interval magic numbers. Reconciliation
  self-heals within one cycle, but TraeX UI changes can cause transient false
  idle/working detections. Prefer structured runtime evidence from Herdr where
  available.
- **Polling intervals and size limits**: several timeouts, poll intervals, and
  payload size limits (25 ms, 50 ms, 250 ms terminal polls, 2 s cache TTL, 750 ms
  card debounce, 100 ms UDP debounce, 12000/28000 character CardKit limits,
  60 s close-code TTL) are hardcoded in their respective modules. These should
  move to the validated configuration surface.
- **Shutdown deadline coordination**: grace periods are per-component rather than
  driven by a shared deadline from the composition root. A coordinated
  `AbortSignal` or deadline passed through shutdown would prevent premature
  timeout of in-flight work.
- **Herdr circuit protection**: repeated Herdr CLI failures during an outage are
  retried on every reconciliation and prompt attempt. A circuit breaker with
  half-open probe would reduce log noise and load during Herdr unavailability.

## Current evolution priorities

1. Model Answer pages explicitly when page-level recovery, audit, or operations
   need more than the active page and outbox history.
2. Make every user-visible lifecycle projection transactional or reconstructible
   from durable aggregate state; do not rely on `BridgeEventBus` as a replay log.
3. Extract prompt execution first, then binding provisioning and operations,
   leaving the coordinator as inbound routing and application composition.
4. Introduce `PromptWorkScheduler` as a best-effort wake-up path while retaining
   startup and periodic durable scans as the correctness mechanism.
5. Narrow the store dependency into capability-focused interfaces so workflows
   do not depend on the entire SQLite surface.
6. Add operational metrics (prompt latency, queue depth, dead-letter count,
   reconciliation duration, delivery latency) and lane-level backlog
   diagnostics; cross-lane concurrency with strict in-lane ordering is already
   implemented.
7. Add per-listener error isolation to the lifecycle event publisher before
   attaching additional subscribers.
8. Replace synthetic `local:` prompt IDs with a dedicated observation event type
   or a proper synthetic prompt record so downstream projections do not
   encounter IDs with no backing row.

## Related documents

- [Feishu group usage](feishu-group-usage.md) explains user commands and safety
  behavior.
- Historical design and iteration records live in
  [archive/](archive/), including [archive/designs](archive/designs/) and
  [archive/superpowers](archive/superpowers/).
