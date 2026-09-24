# Swarm Command Runtime Optimization

## Goal

Turn Swarm command handling into one deep module that gives every ingress a
consistent durable admission model, returns promptly for mutations, converges
execution state through one CardKit card, and derives natural-language risk and
help behavior from one typed command definition. The work must preserve current
authorization, identity fencing, lane ordering, durability, and no-replay
guarantees.

The optimization proceeds in this order: deepen the architecture seam, improve
stability and real-time feedback, then improve natural-language and help
experience. It does not introduce a generic command framework or an in-memory
queue.

## Current problem

The command/control boundary already persists mutation intents, freezes command
context, serializes work by lane, and conservatively terminalizes uncertain work.
Its remaining interface is shallow in three places.

First, `SwarmCommandGateway` exposes ingress-specific operations for Lark
messages, CardKit Worker creation, Primary Tool Worker creation, accepted-intent
draining, recovery, and shutdown. Callers still need to know how resolution,
admission, synchronous waiting, and result reconstruction fit together. Card and
Primary Tool paths duplicate message construction, idempotency, resolution, and
acceptance.

Second, mutation submission waits for the lane drain. A slow Herdr or TraeX
effect therefore delays the inbound response even though SQLite has already
accepted the command. Worker creation additionally uses process-local
`workerResults` and `awaitedWorkerResults` collections to bridge execution back
to a waiting caller. These are latency mechanisms acting as part of the result
interface instead of SQLite being the complete authority.

Third, command policy, natural-language confirmation behavior, help content, and
syntax knowledge are separate. Today every natural-language mutation requires a
confirmation even when the operation is recoverable, while the desired model is
risk-based. Adding a command can leave runtime policy, help, and natural-language
behavior inconsistent.

## Approaches considered

### Extend the current Gateway

Adding status cards and risk checks directly to `SwarmCommandGateway` would be
the smallest patch. It would also leave source-specific methods, admission,
query routing, execution waiting, and presentation in one growing interface. The
same duplication would return when the next ingress is added.

### Introduce a deep `SwarmCommandRuntime` module

One runtime accepts typed requests from every source and hides resolution,
authorization, risk classification, durable admission, status convergence, lane
execution, recovery, and shutdown. This creates leverage for all ingresses while
keeping internal workflow modules focused and testable. This is the selected
approach.

### Build a generic command framework

A plugin registry with dynamically registered handlers would maximize abstract
extensibility, but there is only one production command family and one handler
set. It would expose more concepts to callers, weaken exhaustive TypeScript
checking, and create a hypothetical seam. The design rejects it.

## External interface

Application callers receive one module with this conceptual interface:

```ts
interface SwarmCommandRuntime {
  submit(request: SwarmCommandRequest): Promise<SwarmCommandReceipt>;
  confirm(request: ConfirmSwarmCommandRequest): Promise<SwarmCommandReceipt>;
  observe(intentId: string): Promise<CommandIntentSnapshot>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}
```

`SwarmCommandRequest` is a discriminated union for Lark text, CardKit action,
natural-language interpretation, and Primary Tool sources. Each variant carries
only source-owned identity and the parsed `BridgeCommand`; callers do not create
synthetic Lark messages, choose lane keys, set replay policy, or construct
`CommandIntent`. The runtime normalizes every request into one internal command
submission.

`SwarmCommandReceipt` distinguishes a completed query, a durable mutation
acceptance, a required confirmation, and a rejection. An accepted receipt
contains the stable intent ID and current snapshot, not an in-memory completion
promise. `observe` reads durable state and is used only by programmatic callers
that require structured terminal data, such as Primary Worker creation.

`confirm` validates a durable confirmation and consumes it atomically with
command admission. It does not expose the confirmation store or require the
caller to resolve context twice.

This module is deep by the deletion test: removing it would redistribute source
normalization, policy, context fencing, risk decisions, idempotency, admission,
status projection, execution scheduling, durable observation, recovery, and
shutdown across every ingress.

## Typed command definitions

One closed, compile-time checked definition map supplements the existing parsed
command union:

```ts
type SwarmCommandRisk =
  | "read-only"
  | "recoverable-mutation"
  | "destructive-mutation";

interface SwarmCommandDefinition {
  mode: "query" | "mutation";
  scope: SwarmCommandScope;
  authorization: SwarmCommandAuthorization;
  replay: SwarmCommandReplayPolicy;
  risk: SwarmCommandRisk;
  handler: SwarmCommandHandler;
  syntax: string;
  summary: string;
  examples: readonly string[];
}
```

The map remains a static domain value satisfying
`Record<SwarmCommandKind, SwarmCommandDefinition>`. It drives context resolution,
execution classification, natural-language confirmation policy, capability and
help presentation, and documentation consistency tests. Parsing remains explicit
code over the discriminated command union; there is no dynamic registration,
reflection, dependency container, or generic handler protocol.

The initial risk classification is:

- `read-only`: `help`, `projects`, `spaces`, `panes`, `sessions`, `failures`,
  `status`, and `model` without a name;
- `destructive-mutation`: `stop`, `skip`, and `pane_close_confirm`;
- `recoverable-mutation`: every other mutation, including `reset`, `replace`,
  `reattach`, named `model`, and Worker creation.

The `model` definition is input-sensitive in the same way its current mode is:
without a name it is a query; with a name it is a recoverable mutation.

## Submission and risk policy

All sources share resolution, authorization, and durable admission. Risk affects
only whether a natural-language request requires an explicit confirmation:

| Source | Query | Recoverable mutation | Destructive mutation |
| --- | --- | --- | --- |
| Literal `/swarm` | Execute | Admit | Admit |
| Natural language | Execute | Admit | Confirm, then admit |
| Explicit CardKit action | Execute | Admit | Follow the action's explicit confirmation contract |
| Primary Tool | Execute | Admit when the tool permits it | No new remote high-risk capability |

A literal high-risk `/swarm` command is already an explicit operator statement
and does not receive an additional confirmation. Ambiguous natural language
fails closed and asks for clarification. It never becomes an ordinary Agent
prompt. Existing authorization is re-evaluated at admission, confirmation, and
execution where the frozen context requires it.

The design does not broaden remote control. High-risk TraeX approval stays local
to Herdr. There is no remote approval or denial, arbitrary terminal input,
process kill, or pane kill operation.

## Query and mutation flow

Queries remain non-durable command executions because they have no external
mutation to recover:

```text
normalize -> resolve and authorize -> execute query -> typed result
```

Mutations use one asynchronous durable path:

```text
normalize -> resolve and authorize -> risk gate
  -> atomically persist intent + status view + create-card outbox intent
  -> return accepted receipt
  -> best-effort intent-ID wake-up
  -> lane claim and frozen-context revalidation
  -> execute effect
  -> persist terminal outcome + status projection + patch outbox intent
```

The inbound call returns after the admission transaction, not after Herdr,
TraeX, or Lark delivery. The process-local EventBus transports only an intent ID
as a wake-up hint. A SQLite scan is the convergence path after a missed hint or
restart; no in-memory command queue becomes authoritative.

Commands remain FIFO within a lane and independent lanes may execute
concurrently. The current scope-to-lane mapping remains unchanged unless an
implementation audit finds a demonstrated correctness bug.

## Durable Command Status View

Each mutation owns one durable status projection with these monotonic lifecycle
states:

- `accepted`: committed and waiting for a claim;
- `executing`: claimed and being executed;
- `succeeded`: the requested effect completed;
- `rejected`: authorization, frozen context, or a business precondition failed;
- `failed`: execution failed before an external effect may have started;
- `uncertain`: an external effect may have started and automatic replay is
  unsafe.

The projection records command kind, safe display summary, source, actor, lane,
timestamps, attempt count, outcome code, redacted detail, and optional operation
identity. It does not store secrets, raw Primary Tool credentials, terminal
input, or unrestricted command arguments.

Initial intent, status view, and create-card outbox intent are one SQLite
transaction. Each later state transition and its patch outbox intent are also one
transaction. A duplicate idempotency key returns the existing intent and card
identity; a fingerprint conflict is rejected. Lark delivery retries can only
re-render or patch the projection and can never execute the command again.

The first delivered card becomes the stable target. Later versions patch the
same card after delivery checkpoints are recorded. If the create delivery is
delayed, later state is rendered when the target becomes available rather than
emitting one card per transient state. Projection versions prevent an older
patch from overwriting a newer state.

The card displays the state, command summary, queue or execution message, safe
next action, and a short intent identifier for log correlation. Error content
states whether the effect may have started, whether automatic retry is possible,
and which safe command or local Herdr action the operator should use next.

## Execution and recovery

The internal dispatcher retains owner-lane single flight and reloads every
claimed intent from SQLite. Before an effect it revalidates project, Binding
generation, Pane, terminal, native Agent session, active turn, and Primary Tool
parent Prompt as required by the definition and frozen context.

Recovery preserves the current effect-certainty boundary:

- `accepted` work has not started and is eligible for later claim;
- interrupted `executing` work becomes `uncertain`;
- `uncertain` work is observed or reconciled when a command-specific safe path
  exists, but is never automatically submitted again;
- terminal intents are never re-executed;
- a stale identity becomes `rejected`, not a best-effort execution against a new
  target.

Shutdown stops admission, settles or conservatively terminalizes claimed work,
waits for lane workers, and leaves SQLite plus the outbox recoverable. A status
delivery failure does not block the workflow transition and does not loosen the
instance lease or write fence.

## Programmatic result observation

Primary Tool Worker creation currently waits through process-local result maps.
Those maps are removed as a result authority. The accepted receipt supplies an
intent ID, and `observe(intentId)` reads durable intent and operation outcome. A
bounded waiter may subscribe to intent-ID hints for latency, but it always
re-reads SQLite and can be reconstructed after restart.

Worker creation persists its Worker operation identity in the command outcome.
The runtime reconstructs `CreateWorkerResult` from that identity and the Instance
store. A timeout returns a typed pending or uncertain result without cancelling,
replaying, or losing the underlying intent. Source-specific presentation of that
typed result remains outside the domain policy.

## Natural-language behavior

The deterministic interpreter and Controller continue to produce typed command
results. `NaturalLanguageCommandWorkflow` no longer assumes every mutation needs
confirmation. It submits the typed result to the runtime, which applies the
definition's risk and source policy.

Read-only requests execute immediately. Recoverable mutations receive the same
durable status card as literal commands. Destructive mutations stage the existing
durable confirmation card; confirmation atomically consumes the confirmation and
admits the command. Cancellation and expiry remain terminal and execute nothing.

Controller unavailability retains deterministic fallback. Unsupported control
requests and ambiguities retain guidance cards and never enter command admission.

## Help and discoverability

The help card is rendered from typed definitions and groups commands by operator
task rather than implementation handler:

1. create and connect;
2. inspect status;
3. control current work;
4. recover a session;
5. manage Workers;
6. high-risk operations.

Definitions supply syntax, concise summaries, and examples. Hand-written
documentation may add operational explanation, but tests verify that every
command kind has a definition and that documented literal commands refer to a
known syntax. Generated presentation must not expose commands unavailable to the
current ingress or advertise forbidden remote approval behavior.

## Internal module ownership

`SwarmCommandRuntime` is the external module. Its implementation uses focused
internal modules rather than becoming a monolith:

- a request normalizer converts source variants into one submission context;
- `SwarmCommandContextResolver` owns authorization and frozen identity;
- an admission workflow owns confirmation decisions and atomic intent/status
  creation;
- a query executor dispatches read-only handlers;
- `CommandIntentDispatcher` owns lane draining, revalidation, effect dispatch,
  and conservative settlement;
- a status projector owns durable view transitions and outbox rendering intent;
- a durable observer reconstructs structured programmatic results.

These may retain narrow internal seams for focused tests. They are not all
exported to application composition. Existing provisioning, session, Pane,
model, Prompt recovery, and Worker lifecycle workflows remain the effect owners;
the command runtime coordinates them without absorbing their business logic.

Production construction remains in `src/composition/`. Ingress, CardKit routing,
natural-language handling, and Primary Tools receive only the portion of the
runtime interface they consume. Architecture checks prevent production callers
from importing the dispatcher or concrete command-intent store directly.

## Compatibility and non-goals

The implementation must preserve:

- all literal command spellings, aliases, parser behavior, and typed commands;
- configured-chat and actor allowlists;
- administrator and creator authorization;
- project registry as the routing and security boundary;
- Binding, generation, Pane, terminal, Agent session, Prompt, and active-turn
  fences;
- current lane ordering and cross-lane concurrency;
- idempotency keys or an explicitly migrated equivalent;
- durable outbox delivery and CardKit sequence ordering;
- no automatic replay after possible external delivery;
- exact-turn stop and steering restrictions;
- local-only high-risk TraeX approval;
- existing SQLite data through additive, ordered migration.

This work does not add commands, create or delete configured projects or Herdr
workspaces, redesign Instance commands, replace SQLite with an in-memory queue,
make Lark authoritative, or split every handler into a new public module.

## Error handling

- Invalid syntax returns help or guidance without admission.
- Authorization and missing-scope failures return a typed rejection and durable
  audit record without creating an executable intent.
- Idempotency conflict returns a rejection; exact duplicate returns the existing
  receipt and projection.
- Failure before possible effect records `failed`; failure after possible effect
  records `uncertain`.
- Context changes before execution record `rejected` with a safe next action.
- Card creation or patch failure remains in the outbox retry/dead-letter path and
  never changes command execution state.
- A programmatic observation timeout reports pending durable state and does not
  cancel the command.
- Unsafe recovery remains explicit and requires operator action rather than
  optimistic replay.

## Implementation sequence

1. Add typed definitions and risk metadata while preserving existing policy and
   help behavior.
2. Introduce normalized requests and typed receipts behind the current Gateway;
   migrate source-specific admission without changing execution timing.
3. Add the durable Command Status View, additive migration, atomic transitions,
   renderer, and outbox convergence.
4. Return accepted receipts immediately and wake the background lane dispatcher.
5. Replace process-local Worker result authority with durable observation.
6. Move literal Lark, CardKit, Primary Tool, and natural-language sources onto the
   runtime interface and narrow composition dependencies.
7. Apply risk-based natural-language confirmation.
8. Render grouped help from definitions and add documentation consistency checks.
9. Remove superseded Gateway methods and implementation-shaped tests, then update
   architecture and operator documentation.

Each behavior-preserving structural step and each user-visible behavior step must
be independently testable and committed thematically.

## Verification

Focused tests must demonstrate:

- exhaustive command definitions and unchanged parsing;
- source normalization and identical authorization across all ingresses;
- literal versus natural-language risk policy;
- atomic admission of intent, status projection, and outbox work;
- mutation submission latency independent of external execution duration;
- duplicate reuse and idempotency conflict;
- same-lane FIFO and cross-lane concurrency;
- monotonic same-card convergence and stale patch suppression;
- accepted restart recovery and interrupted executing-to-uncertain recovery;
- no replay after possible effect;
- stale project, Binding generation, Pane, terminal, Agent session, Prompt, and
  active-turn rejection;
- Lark delivery failure without command re-execution;
- durable Primary Tool Worker result reconstruction without process-local result
  authority;
- shutdown settlement and later recovery;
- help and documentation consistency;
- secret redaction in projection, errors, and logs.

The final gate is the affected focused suites followed by `npm run typecheck`,
`npm run build`, `npm run architecture:check`, `npm run docs:audit`, `npm test`,
and `git diff --check`.
