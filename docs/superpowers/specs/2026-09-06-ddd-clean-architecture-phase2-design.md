# DDD and Clean Architecture Phase 2 Design

## Status

Approved for implementation by the request to complete review items 1-8. This
document refines those items into reversible implementation stages. It does not
change the runtime authority model or user-visible workflow semantics.

## Objective

Deepen the existing architecture without weakening its durability guarantees:

- Herdr remains authoritative for live pane, terminal, Agent session, and turn state.
- SQLite remains authoritative for workflow state and delivery intent.
- Lark remains a presentation target.
- Wake-ups remain best-effort hints and never become durable facts.
- A prompt that may have reached TraeX is never automatically replayed.
- Aggregate state, projection state, and outbound intent remain atomic where the
  current implementation commits them in one SQLite transaction.

## Considered approaches

### A. File-size-driven decomposition

Split every large source file into smaller classes. This improves local file size
but risks shallow modules, transaction fragmentation, and additional forwarding.
It is rejected.

### B. Rewrite around independent repositories and a generic event bus

Move each table behind a repository and coordinate changes through events. This
would weaken the current atomic prompt/projection/outbox transitions and create
new failure windows. It is rejected.

### C. Capability-first, strangler-style deepening

Keep stable facades and the shared SQLite transaction context while extracting
cohesive policies and use cases behind narrow interfaces. Replace presentation
payloads in persistence incrementally with typed delivery intents. Migrate tests
away from the broad compatibility store before removing that surface. This is the
selected approach.

## Bounded contexts

### Primary Session

Owns `Binding`, pane attachment, lifecycle, provisioning checkpoints, runtime
identity, reset, replacement, and recovery. A binding is externally described as
a Topic-Pane Binding; `Binding` remains the concise internal name.

### Prompt Execution

Owns ordinary prompt FIFO, dispatch evidence, model-aware dispatch, steering,
attached and detached observation, exact transcript identity, and the no-replay
rule.

### Worker Runtime

Owns Worker identity, runtime generation, Worker session generation, turns,
ownership by an exact Primary generation and pane, and Worker task interactions.

### Conversation Projection

Owns Topic, Run, Worker Main, Worker Task, Answer-page, and card-context read
models. These are projections, not execution aggregates.

### Delivery and Operations

Owns durable outbound intent, lane ordering, retry, quarantine, dead letter,
delivery checkpoints, audit, health, and operational diagnostics.

## Stage 1: Worker card ownership policy

Extract the repeated Worker-card fences from `InstanceInteractionWorkflow` into a
pure domain policy. The policy accepts an immutable card identity and current
binding/instance/view facts and returns an explicit decision such as `allowed`,
`stale`, `wrong_owner`, `inactive_parent`, or `missing`.

The identity includes Worker ID, instance generation, Worker session generation,
parent binding ID, parent binding generation, and parent pane ID. Every Worker
Task and Worker Main action must pass this policy before a use case is invoked.

This stage must preserve the rule that a direct reply to a Worker Task card is a
Primary message. Worker steering and follow-up remain explicit card actions.

## Stage 2: Prompt-run decomposition

Keep `PromptRunWorkflow` as the public lifecycle facade. Extract the following
deep collaborators in small steps:

- `PromptSafetyScanner`: stale undispatched-claim recovery, durable work scans,
  backoff, and scan diagnostics.
- `PromptRunRegistry`: per-binding ordinary and steering worker ownership plus
  active-turn supervision.
- `TranscriptObserver`: transcript opening, exact turn claiming, conflict fences,
  attached polling, final drain, and detached polling.
- `PromptTurnExecutor`: execute one claimed prompt and return a terminal outcome
  of completed, failed, detached, or ignored.

`PromptRunWorkflow` continues to own subscription, wake routing, FIFO drain, and
shutdown orchestration. `PromptTurnExecutor` must persist dispatch evidence before
an error can be classified as detached. Neither safety scan nor recovery may
resubmit a possibly dispatched prompt.

## Stage 3: Instance interaction use cases

Reduce `InstanceInteractionWorkflow` to routing across narrow use cases:

- directory and detail queries;
- Worker lifecycle forms and commands;
- Worker Task interactions;
- Worker Main interactions;
- conversation-context resolution.

Each use case receives only the store and presentation capabilities it consumes.
The router remains responsible for mapping normalized Lark input to a use case,
not for applying ownership rules itself.

## Stage 4: Runtime reconciliation layers

Separate reconciliation mechanism from convergence policy:

- `HerdrReconciliationScheduler` coalesces hints, applies cooldown, schedules
  periodic runs, and exposes diagnostics.
- `RuntimeSnapshotCollector` loads and normalizes fresh authoritative Herdr
  observations.
- `BindingRuntimeConvergencePolicy` is pure and classifies an observation as
  unchanged, observe, orphan, recover, degrade, or rename.
- `BindingRuntimeConverger` executes the selected identity-fenced durable
  transition and triggers normal projections/events.

Full and event-driven reconciliation use the same path. Socket events never carry
authoritative lifecycle decisions. External-turn observation must not run in
parallel with binding convergence for the same pane.

## Stage 5: Binding provisioning use cases

Keep `BindingProvisioningWorkflow` as a facade while separating project selection,
new Primary provisioning, existing-pane attachment, replacement/reattachment, and
startup recovery. New Primary provisioning remains one durable saga:

`pending binding -> pane created -> runtime started -> thread created -> active`.

The saga owns checkpoint interpretation. Low-level pane and topic helpers must not
independently advance checkpoints. Interrupted operations remain recoverable or
fail closed according to their existing durable evidence.

## Stage 6: Typed durable delivery intents

Remove renderer callbacks and raw CardKit objects from core-facing persistence
ports incrementally. Introduce typed, presentation-neutral snapshots for each
delivery intent. The transaction stores the aggregate transition, projection
version, and typed intent together. An outbound materializer converts the typed
intent to a versioned CardKit payload before Lark delivery.

Migration order is Main Card, ordinary Run Card, Worker cards, then Answer stream
and recovery. Existing payload rows remain deliverable. New rows carry an explicit
intent schema and renderer revision. Retry must use a deterministic materialized
payload or an immutable snapshot plus pinned renderer revision; it must not render
against arbitrary current state.

Answer streaming is last because frozen pages, source offsets, CardKit sequence,
and recovery checkpoints are part of the delivery contract.

## Stage 7: Domain types and ports

Move types from `domain/types.ts` to their owning contexts without changing their
wire or storage shape. Start with leaf types and provide temporary re-exports to
keep stages reviewable. Target modules include binding, prompt, delivery, runtime
observation, project selection, and operations.

Move normalized Lark ingress DTOs and health/dispatcher diagnostics out of the
business domain. Introduce compound identity values only where the code repeatedly
checks a generation, pane, session, or transcript tuple. Do not brand every ID.

Split port files by consumer capability rather than database table. A concrete
CardKit adapter may implement multiple narrow presentation ports, but workflows do
not receive the broad `ApplicationPresentation` interface.

## Stage 8: Store kernel and test migration

Keep one `SqliteContext` and one connection. Preserve nested transaction
participation. Move new tests to `createTestStoreBundle()` and pass only the
capability under test. Migrate existing tests in bounded batches.

After consumers no longer require it, move the broad `SqliteBindingStore` facade
to test compatibility support or remove it. `SqliteStoreKernel` then remains an
internal capability assembler and home for the few genuinely cross-capability
atomic operations; it must not become a second application service.

`SqlitePromptStore`, `SqliteOutboxStore`, and historical migrations are not split
by line count. Migration cleanup may introduce an ordered registry and thematic
modules, but migration order and idempotent compatibility behavior are immutable.

## Data and error flow

For an inbound task, the application validates ownership and context, then calls
one aggregate-oriented store operation. SQLite commits accepted work, projection
state, invalidations, and outbound intent atomically. Only afterward is a scheduler
or outbound worker awakened.

For runtime execution, a FIFO worker claims durable work, records dispatch
evidence at the Herdr boundary, and observes the exact transcript turn. An error
before dispatch may fail the prompt. An error after possible dispatch detaches the
observer and never replays the prompt.

For delivery, the dispatcher claims a lane head, materializes or loads its pinned
payload, sends it once per idempotency identity, and records its checkpoint. A
delivery retry never invokes a domain command or TraeX prompt.

## Testing strategy

Each extraction begins with characterization tests for its current behavior.
Required focused coverage includes:

- stale Worker Task and Worker Main actions across all identity fields;
- one ordinary prompt per binding, FIFO order, steering ordering, dispatch fence,
  detached recovery, transcript conflict, and shutdown;
- full and scoped reconciliation producing identical convergence decisions;
- provisioning recovery from every durable checkpoint;
- aggregate/projection/outbox atomic rollback;
- deterministic typed-intent materialization and compatibility with old payloads;
- capability-only test construction without the compatibility facade.

Every stage must pass affected Vitest files, `npm run typecheck`, and
`npm run build`. Changes spanning workflow or persistence require `npm test`.
Architecture tests will forbid new presentation imports from domain/store modules,
new production references to the compatibility facade, and broad presentation
dependencies in extracted workflows.

## Delivery strategy

Implement as thematic commits. Each commit leaves the service buildable and does
not require a data migration unless the typed-intent stage explicitly introduces
one. No deployment, service restart, remote push, or merge is part of this design
unless separately requested.

## Completion criteria

All eight stages are complete only when their old responsibilities are removed or
explicitly retained with a documented reason, focused behavior tests pass, the
architecture boundary tests cover the new dependency rules, the full test suite
passes, TypeScript typecheck and production build pass, and `git diff --check` is
clean.
