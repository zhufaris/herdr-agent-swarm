# Core Event Card Realtime

## Problem Statement

Herdr Core incrementally tails complete JSONL records and commits normalized
events into its durable journal and per-session Event Ring. Swarm consumes that
Ring, projects canonical conversation state into SQLite, and delivers Turn Card
revisions through Prepared Delivery and the owning Primary Pane Delivery Ring.
The current path has five observable gaps:

1. Swarm's two-second session-ingestion scan is the only explicit fallback and
   does not use Core's existing `session.events.available` notification as an
   exact source wake-up.
2. A burst that exhausts an ingestion or observation page can wait for another
   periodic scan instead of immediately continuing.
3. Conversation Segment cards bypass the shared card-update scheduler, while
   that scheduler uses an earliest-deadline window rather than a true 250ms
   trailing-edge window.
4. Core currently discards TraeX/Pi model and context-compaction records and
   drops the model reported by TraeX Subagent spawn events.
5. A Primary Pane discovered or attached after direct Herdr creation shows a
   persistent orange `Primary tools unavailable` warning even while ordinary
   conversation and event projection work normally. The warning overstates the
   operational difference between direct and Bridge-created Panes.

The intended result is event-level streaming: each complete, durable Core event
normally becomes visible in Feishu within one second, while bursty nonterminal
updates are coalesced safely. This does not claim token-level streaming for an
Assistant message that TraeX or Pi has not yet written as a complete JSONL
record.

## Solution

Extend Core's source-neutral event protocol with `model_changed` and
`context_compacted`, and add optional `model` metadata to `agent_activity`.
Normalize the corresponding TraeX and Pi records without exposing private or
large source fields. Preserve deterministic event identity through decoder
checkpoint state.

Teach Swarm to accept and persist those events, subscribe to Core's existing
`session.events.available` notification, and route each notification to the
exact Primary or Worker ingestion owner when known. Continue a bounded backlog
immediately instead of waiting for periodic reconciliation. Route all mutable
Turn Card convergence through one keyed scheduler: first content and semantic
boundary events flush immediately, while ordinary bursts use a true 250ms
trailing-edge window. SQLite remains the restart authority and the two-second
scan remains a safety fallback.

Deploy the tolerant Swarm consumer before the Core producer. The globally
installed `herdr-choice-list` plugin remains enabled for every newly started
TraeX process; its eligibility check makes non-Swarm sessions fail open. Existing
TraeX processes are not restarted automatically because plugins are loaded at
process start.

Remove the persistent Primary-tools warning from the normal Main Card. Keep the
generation-scoped capability fact and every server-side authorization check;
when a user actually invokes an unavailable Primary-only tool, return the
existing contextual rejection and recovery guidance through that operation's
result instead of advertising it continuously on an otherwise healthy card.

## User Stories

### SCN-1: Incremental visible Assistant messages

When an active Primary or Worker emits several complete Assistant message
records during a long turn, the first visible message updates its Turn Card
immediately and subsequent burst updates converge to the latest durable view
after 250ms of quiet. Under normal connected conditions, each committed Core
event is reflected in Feishu within one second.

### SCN-2: Context compaction

When TraeX emits `context_compacted` or Pi emits `compaction` during an active
turn, Core emits one canonical marker and Swarm appends
`🗜️ Context compacted` at that event's canonical timeline position. The marker
flushes immediately. Compaction details and summaries are never exposed. If no
mutable turn owns the event, it remains durable history and does not mutate a
frozen card.

### SCN-3: Main-Agent model state

When the runtime first reports a model or changes it, Core emits
`model_changed`. Swarm updates the mutable Main/Turn projection, keeps the
current model in the Answer Card identity, and appends
`🧠 Model · <name>` for a change owned by the active turn. Duplicate reports of
the same current model do not produce another event. A later `A -> B -> A`
transition produces three distinct, replay-stable observations.

### SCN-4: Subagent lifecycle and model

When TraeX reports Subagent spawn and later lifecycle changes, Core emits the
existing `agent_activity` with optional model metadata. Swarm uses one stable
timeline item per Subagent, for example
`🤖 Agent · reviewer · GPT-5.6-Sol`, and updates its lifecycle in place.
Terminal states flush immediately. Missing model metadata remains absent and is
never inferred from prose.

### SCN-5: Retry, restart, and overload

Duplicate notifications and replayed Core events do not create duplicate
timeline items or outbound effects. If the source-to-owner map is not yet
available, Swarm requests one coalesced full ingestion pass. If a batch limit is
reached, the same owner is immediately rescheduled. Process restart loses only
volatile timers; durable projection debt is recovered from SQLite without
replaying Agent Input. Delivery ambiguity and quarantine retain their existing
behavior.

### SCN-6: Choice Hook availability

After installation, every newly started TraeX process loads the global
`herdr-choice-list` Stop Hook. Only a Swarm-managed process with valid
Binding/generation/project identity can create a Choice Specification. A
non-Swarm process fails open. An already-running TraeX process is left intact
and is explicitly reported as requiring restart before the Hook can be used.

### SCN-7: Direct Herdr Pane presentation

When a healthy TraeX Pane created directly in Herdr is attached or discovered,
its Main Card uses the same normal visual hierarchy as a Bridge-created Pane and
does not show the persistent orange Primary-tools warning. Its internal
generation-scoped capability remains unavailable. If the user invokes a
Primary-only tool, that operation fails safely with contextual recovery
guidance; ordinary Agent Input, Core event projection, Answer cards and Worker
status remain unaffected.

## Implementation Decisions

### Domain Model

The **Core Event** remains an immutable normalized fact owned by Herdr Core.
`model_changed`, `context_compacted`, and `agent_activity.model` are additive
facts, not commands and not card payloads. Core JSONL remains the source fact;
the Session Event Ring is the live transport and bounded cache.

The **Conversation Projection** owns the current visible model and ordered
timeline items. It never owns Agent execution. A context-compaction marker has
occurrence identity and canonical position but no content. A Subagent activity
item has stable Agent identity and is updated by later lifecycle facts.

The **Delivery and Operations** context owns coalescing and external effects.
Its convergence scheduler is volatile; SQLite projection state, Prepared
Delivery, Delivery Ring order, checkpoints, retry, and quarantine remain the
durable guarantees.

### Invariants

- **INV-1:** Swarm never reads or projects a partial JSONL record.
- **INV-2:** Normal and historical Core recovery produce the same event ID for
  the same source fact.
- **INV-3:** Repeated compact occurrences and `A -> B -> A` model transitions
  remain distinct; duplicate replay of one occurrence remains idempotent.
- **INV-4:** Core does not expose compaction summaries, prompts, paths, full
  settings, private reasoning, or unbounded model/Agent metadata.
- **INV-5:** Projection state commits before any CardKit effect is offered to a
  Delivery Ring.
- **INV-6:** Coalescing may replace only an unexecuted mutable card snapshot. It
  never removes canonical events, reorders a Pane Ring, patches a frozen page,
  or replays Agent Input.
- **INV-7:** Worker delivery remains scoped and fenced by its parent Primary
  Pane.
- **INV-8:** Missing notifications, unknown source mappings, process restart,
  and subscription loss converge through bounded immediate rescheduling and the
  existing periodic recovery path.
- **INV-9:** Removing the persistent card warning does not create, infer, copy,
  or bypass a Primary tool capability. Capability authorization remains
  generation-scoped and enforced at the tool boundary.

### Architecture

#### Herdr Core adapter and event journal

`ReplyPayload` gains:

```text
ModelChanged { model }
ContextCompacted
AgentActivity { agent_id, display_name?, model?, state }
```

TraeX `thread_settings_applied` and Pi `model_change` map to
`ModelChanged`. TraeX `context_compacted` and Pi `compaction` map to the marker.
TraeX spawn records populate an optional, bounded Agent-model cache used by
subsequent activity records.

Decoder checkpoints add defaulted last-model, transition counters, compaction
counters, and bounded Agent-model state. Keys use deterministic persisted
occurrence counters or native Pi IDs; they never use runtime randomness, Core
source IDs, file offsets, or decode-time clocks. Journal commit continues to
persist events and decoder checkpoint atomically.

The existing Core collector, `session.events.available` notification, Event
Ring read/subscribe APIs, retention, epoch, and cursor semantics are reused.

#### Swarm Core-event adapter

The adapter accepts the new payloads and optional Agent model. It preserves the
batch cursor while ignoring future unknown additive payload variants so one
unsupported event cannot poison later known events. Known malformed payloads
still fail closed.

The Herdr event subscriber adds `session.events.available` to its subscriptions
and carries bounded source IDs through a dedicated hint variant. Runtime pane
hints and Core source hints remain separate meanings.

#### Session ingestion

The ingestion supervisor maintains a bounded source-ID-to-owner map obtained
from successfully attached session sources. A source hint schedules only that
owner. An unknown mapping requests one coalesced full pass, which populates the
map. Per-owner serialization remains in place.

When Core or local projection page limits are reached and more work is known to
exist, the owner requeues itself immediately. The existing two-second periodic
scan remains fallback recovery rather than the normal delivery path.

#### Conversation projection and delivery

The Core event projector translates the new facts into current model state and
stable timeline deltas. Context compact and model changes carry the canonical
lane position assigned by the existing inbox transaction. Subagent state keeps
one stable item identity while its visible state and optional model evolve.

Conversation Segment projection emits a post-commit convergence request with
segment ID, view version, and urgency. A shared keyed card-convergence scheduler
implements:

- immediate flush for first visible Assistant content, turn terminal events,
  model changes, context compact, and terminal Subagent activity;
- true trailing-edge 250ms coalescing for other nonterminal updates;
- immediate continuation after an in-flight update when a newer immediate
  revision arrives;
- bounded retry using the existing delivery/recovery mechanisms.

The scheduler does not persist timers or payloads. The converger renders the
latest committed SQLite view and reserves Prepared Delivery through the
existing transaction and post-commit handoff.

### Dependency Direction

- Core source codecs depend on Core event-domain payloads, not Swarm or Lark.
- Swarm adapters translate Core JSON into Swarm domain events.
- Conversation projection decides visible state and urgency without importing
  the Lark SDK.
- The application scheduler depends on the Turn Card convergence interface.
- Gateway rendering and delivery remain outer adapters.
- Composition wires Core notifications, ingestion, scheduling, and Pane Ring
  delivery.

### Behavior and Failure Modes

- Invalid or oversized model values are rejected or skipped at the Core source
  boundary without wedging the source.
- Duplicate source notifications coalesce; duplicate Core event IDs are
  idempotent in the inbox and projection.
- Notification disconnect falls back to the periodic scan.
- Unknown source ID causes one coalesced discovery scan, not an unbounded scan
  per notification.
- A CardKit failure leaves durable Prepared Delivery retry/quarantine state and
  does not repeat Core ingestion or Agent execution.
- Events arriving after a page freezes do not mutate it; existing continuation
  and late-evidence rules apply.

### Compatibility and Migration

Deployment is consumer-first:

1. install a Swarm version that accepts the new payload shapes;
2. restart and verify Swarm;
3. install/restart Core so it begins emitting the new facts;
4. verify Core event ingestion and Feishu cards;
5. create a new Swarm-managed TraeX Primary for Choice Hook acceptance.

Core keeps `schema_version = 1`; the new payload variants are additive. Existing
`agent_activity` JSON without `model` remains valid. Generated next-version API
schema is updated; published stable documentation is not edited.

The Choice plugin stays globally installed and enabled. Installation verifies
its activation and tells operators that already-running TraeX processes require
restart. It never automatically terminates active Agent processes.

#### Primary capability presentation

The Topic Projection may retain `primaryToolsAvailable` and its diagnostic
reason for authorization and operator inspection, but the normal Main Card
renderer no longer emits the orange callout solely because the value is false.
No provisioning, attachment, capability issuance, reset, replacement, or tool
gateway rule changes. The existing tool invocation path remains responsible for
returning an actionable error when the capability is actually required.

## Testing Decisions

- Core codec tests cover TraeX and Pi model/compact mapping, duplicate model
  suppression, `A -> B -> A`, repeated compact identity, malformed values,
  bounded Agent-model cache, and no private-field leakage.
- Core checkpoint/journal tests cover old-checkpoint deserialization, restart,
  commit retry, live/recovery ID equality, Ring snapshot restoration, and old
  `agent_activity` compatibility.
- Swarm adapter and persisted-codec tests cover all new payload forms and
  future unknown-event batch tolerance.
- Socket/router tests cover `session.events.available`, exact source routing,
  duplicate hint coalescing, and unknown-source fallback.
- Ingestion tests cover more than eight observed events, Core batch limits,
  immediate self-rescheduling, and disconnected periodic recovery.
- Scheduler fake-clock tests cover a true 250ms trailing edge and immediate
  pending/in-flight promotion.
- Conversation integration tests prove durable commit before scheduling,
  stable model/compact/Subagent projection, frozen-page behavior, Primary and
  Worker ownership, Prepared Delivery, Pane Ring ordering, retry, and reopen.
- A deterministic latency harness measures Core availability through prepared
  delivery: ordinary events under one second and semantic boundaries with no
  debounce delay.
- Main Card tests prove a healthy direct/attached Pane has no persistent
  Primary-tools warning while its stored capability remains false; tool-gateway
  tests prove the same Pane still cannot invoke an unauthorized Primary tool.
- Live acceptance uses a newly created Swarm-managed TraeX Primary and verifies
  Hook discovery, Choice buttons, card ACK before one mention, and no duplicate
  Prompt/Turn.

## Out of Scope

- Token- or character-level streaming for an incomplete source record.
- Parsing terminal output or prose to infer model, compaction, or Agent state.
- Exposing compaction summaries, hidden reasoning, prompts, paths, or full
  runtime settings.
- Rewriting frozen Answer pages or historical cards.
- Cleaning production data.
- Automatically restarting existing TraeX processes.
- Automatically provisioning Primary tool credentials into an already-running
  direct Herdr Pane or weakening generation-scoped capability checks.
- Pushing repositories or opening pull requests.

## Further Notes

Swarm workspace: `/workspace/herdr-agent-swarm`, in-place on `main`, starting
revision `1dc9df1cfd04364916593b6baa901204901d8772`.
Task-owned initial change: the two new unchecked `TODO.md` items. Preserved
user-owned untracked files:

- `docs/research/2026-10-02-session-message-jsonl-dependencies.md`
- `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`
- `handoff.md`

Swarm baseline: `npm test`, 286 files and 4,056 tests passed.

Core implementation workspace:
`/workspace/herdr-core-conversation-activity-events`,
branch `feat/core-conversation-activity-events`, starting revision `71432baa`.
The shared Core checkout had only its pre-existing untracked `.trae/` path.
Core event-focused baseline passed 73 tests. The complete suite compiled but six
existing CLI Agent-detection tests fail because the harness expects Pi while the
host identifies Codex; the failure reproduces with inherited Herdr variables
removed and is unrelated to the event codec. This environmental baseline debt
must remain visible in delivery reporting and may not be attributed to this
change.

Gate 1 approved the original design in conversation on 2026-10-07. The reopened
Gate 1 selected removal of the persistent warning while preserving all internal
capability enforcement. Revised Gate 2 was approved on 2026-10-07.
