# Group Orchestrator Binding and Context Clear

## Problem Statement

The configured Feishu group currently treats an otherwise unbound root message
that mentions the bot as a request to provision a new task Primary. Repeating
that interaction creates another Herdr Pane and another Feishu Thread. The
group therefore has no stable top-level Agent that can coordinate the existing
Herdr/Swarm topology.

The intended behavior is one project-configured Orchestrator for the configured
Gateway/chat. Its Feishu Thread, Herdr Workspace, Pane, Pane token, Pane label,
Binding, and TraeX Agent remain stable across ordinary turns. Initialization is
lazy: the first allowed user who mentions the bot in a group-root text message
creates the managed Orchestrator without a separate init command. Conversation
then happens in that fixed Thread, where allowed users need not mention the bot.

The Orchestrator also needs `/swarm clear`. Clear must remove the context used by
future TraeX turns and withdraw the Orchestrator's prior Answer Cards, but it
must not replace or rename the Pane, rotate its Pane token, invalidate its
Binding, or disturb its Workers. The current Herdr 0.9.0 command surface has no
safe same-Pane Agent-session rotation operation, the current Binding model
treats a native session change as an identity violation, and the outbox has no
typed Lark message-deletion intent.

The separately recorded TODO about adopting a Primary discovered from a Pane
created directly in Herdr remains deferred. This change manages a newly
provisioned Orchestrator and does not authorize an uncredentialed discovered
Pane.

## Solution

Extend the existing Binding model instead of introducing a parallel
Orchestrator aggregate:

- add `Binding.kind: "task" | "orchestrator"` and backfill existing rows as
  `task`;
- add a monotonically increasing `sessionEpoch` to distinguish intentional
  same-Binding context rotations from Binding-generation replacement;
- allow at most one non-terminal Orchestrator Binding for a Gateway/chat;
- add an optional strict `orchestrator` block to each project configuration;
- when enabled on the default project, lazily ensure the fixed Orchestrator from
  the first allowed-user group-root `@Bot` message and submit that message as
  its first ordinary Prompt exactly once;
- route later ordinary messages in the fixed Thread into the same Binding FIFO
  without requiring `@Bot`, while preserving all existing task Primary,
  Pane-entry alias, and Worker Thread routes;
- launch the Orchestrator as a managed TraeX Pane with binding-scoped Primary
  tool credentials and a bounded Orchestrator tool profile;
- add administrator-only `/swarm clear`, whose confirmation action creates a
  durable, fenced `OrchestratorClearOperation`;
- rotate only the TraeX native session in the same Pane through a new exact and
  idempotent Herdr capability, advance `sessionEpoch`, reset current
  Orchestrator projections, and enqueue typed `message.delete` outbox work for
  prior Orchestrator Answer Cards.

Configuration for this deployment will ultimately be:

```json
{
  "orchestrator": {
    "enabled": true,
    "cwd": "/workspace"
  }
}
```

on the `herdr-agent-swarm` project. The project `workspaceId` remains the
Orchestrator's Workspace identity. Live configuration must not be edited until
a compatible build is installed and a separate operational gate authorizes
validation and restart.

## User Stories

### SCN-1: Lazy fixed-thread initialization

Given the default project has Orchestrator enabled and no Orchestrator Binding
exists for the configured Gateway/chat, the first allowed user sends a
group-root text message that mentions the bot. The Bridge durably selects the
default project's Orchestrator route, creates exactly one managed TraeX Pane at
the configured Orchestrator directory, creates exactly one Feishu Thread and
Main Card, and submits the source text as the initial Prompt exactly once.
Duplicate delivery of the same Lark event converges on the same selection,
Binding, Pane, Thread, and Prompt.

Concurrent eligible root messages cannot create two active Orchestrators. One
request wins the durable Gateway/chat reservation; a losing request resolves
the winner and receives the existing fixed-Thread entry rather than creating a
second Pane. A provisioning failure remains recoverable through the existing
checkpoints and must not cause the initial Prompt to be replayed after it may
have reached TraeX.

### SCN-2: Fixed-thread conversation and root behavior

An allowed user's ordinary text inside the active Orchestrator Thread enters
the Binding's existing ordinary FIFO without requiring a bot mention. The
Orchestrator uses one Pane and one native session until an authorized clear.

After the fixed Thread exists, another group-root mention does not create a new
task Primary and does not silently submit work from outside the fixed Thread.
It returns or shares the stable Orchestrator Thread entry. Explicit `/swarm`
commands retain their own command semantics; for example, `/swarm new` remains
the explicit way to create a separate task Primary.

Messages in task Primary Threads, Pane-entry alias Threads, and Worker Threads
continue through their existing routes. Enabling an Orchestrator must not make
those scopes resolve to the Orchestrator.

### SCN-3: Fenced orchestration tools

During an exact active Orchestrator turn, its managed Primary credential grants
the existing project-scoped Worker lifecycle and messaging tools plus bounded
read-only Herdr topology inspection needed to choose managed targets. Mutating
tools operate only on persisted, same-project managed instances and revalidate
Binding/Worker generation, Pane identity, native session identity, parent turn,
and idempotency identity at the server.

The tool profile does not expose arbitrary terminal input, raw key injection,
remote approval or denial, arbitrary process kill, Pane kill, unsafe retargeting,
deployment, push, or unrestricted filesystem/process control. High-risk TraeX
approval remains local to Herdr. Exact-turn interrupt and steering retain their
existing refusal behavior when ownership or runtime identity is stale.

### SCN-4: Request and confirm clear

An administrator sends `/swarm clear` in the fixed Orchestrator Thread. The
Bridge shows a confirmation card describing that TraeX context and prior
Orchestrator Answer Cards will be cleared while Pane identity and Workers are
retained. The command performs no mutation before an authorized, unexpired,
single-use confirmation is claimed.

Clear is rejected if the current Binding is not an Orchestrator, the actor is
not an administrator, the confirmation is stale or already consumed, the
Binding generation/Pane/terminal/native-session fence changed, the Pane is not
observably idle and composer-ready, or the Binding has any queued, submitted,
running, recovering, uncertain, detached, or otherwise nonterminal Prompt.
Rejection leaves both TraeX context and cards unchanged.

### SCN-5: Successful clear with stable Pane identity

After confirmation and a second eligibility check, the Bridge records a durable
clear operation and asks Herdr Core to rotate the TraeX native session in the
exact Pane. The request uses a stable operation ID and exact expected Pane,
terminal, native-session, and idle-state fences. Core returns an idempotent
receipt for the same operation ID.

On success, the Binding keeps its ID, generation, Workspace ID, Pane ID, Pane
token, Pane name/label, project, fixed Thread, creator, and Workers. Only the
native Agent session identity changes and `sessionEpoch` increments. The Main
Card is reset to an idle/new-context view. All later Prompts are stamped with
the new epoch and cannot append to or revive projections from an earlier epoch.
SQLite Prompt, transcript, Answer, audit, and operation history remains intact.

### SCN-6: Answer-card withdrawal and partial failure

The confirmed operation snapshots every delivered Lark message ID belonging to
an Orchestrator Answer page from an earlier epoch and records one idempotent
typed deletion intent per target. It does not delete the Orchestrator Main Card,
confirmation/result cards, task Primary cards, Worker cards, or SQLite history.

Lark deletions run through the durable outbox. Already-absent targets count as
success. Retriable failures follow bounded outbox retry; permanent or exhausted
failures become terminal failures attached to the clear operation. Once every
target is terminal, the operation reports exact deleted/already-absent/failed
counts. A partial Lark failure never rolls back the successful TraeX context
rotation, never restores a deleted card, and never repeats a Prompt.

### SCN-7: Crash and timeout recovery

If the process stops before the external rotation begins, the accepted operation
can be claimed again. If it stops or times out after Core may have rotated the
session, the operation becomes uncertain and reconciliation queries or repeats
the same Core operation ID; it never performs an unkeyed second rotation. Once
the rotation receipt is recovered, the SQLite epoch/session transition and
deletion intents converge exactly once. Startup and periodic reconciliation own
this recovery.

If Core proves that the fence lost before rotation, the operation is rejected.
If Core cannot prove whether a legacy/unkeyed effect occurred, the operation
remains visibly uncertain and requires operator repair; the Bridge must not
guess a new session identity or restart the Pane.

## Implementation Decisions

### Domain Model

This change crosses five existing bounded contexts without merging their
authoritative state:

| Context | Model and responsibility |
| --- | --- |
| Primary Session | `Binding` remains the aggregate root for a fixed Lark/Pane association. `kind` distinguishes task work from the group Orchestrator; `generation` fences replacement, while `sessionEpoch` fences intentional same-Pane context history. The Orchestrator action `clearContext` is allowed only for a current active Orchestrator with no nonterminal Prompt. |
| Prompt Execution | Prompt FIFO and dispatch remain binding-scoped. Each Orchestrator Prompt captures the accepted `sessionEpoch`; dispatch and projection reject an epoch that is no longer current. Prompt rows and transcript lineage are retained after clear. |
| Conversation Projection | Main and Answer projections remain durable SQLite facts. Clear resets only the current Main projection and marks earlier-epoch Answer surfaces for withdrawal; historical projections are not deleted or rewritten. |
| Delivery | The outbox owns each Lark `message.delete` attempt, idempotency, retry, effect certainty, and terminal outcome. Lark never becomes workflow truth. |
| Operations / Worker Runtime | `OrchestratorClearOperation` owns confirmation-to-completion state and exact counts. Existing Worker aggregates remain parented by Binding generation, not session epoch, so clear does not invalidate or recreate them. |

`BindingKind` is a closed value (`task` or `orchestrator`). Missing historical
values migrate to `task`; no runtime inference from title, chat, Pane label, or
cards is allowed. `sessionEpoch` is a positive monotonic integer initialized to
1. Binding generation and session epoch have deliberately different meanings:
replacement/retargeting increments generation and invalidates Workers and
capabilities, while successful same-Pane clear increments only epoch and mints
a new turn-scoped Primary capability on the next Prompt.

The significant invariants are:

- **INV-1 — Singleton route:** at most one non-terminal Orchestrator Binding
  exists per `(gatewayId, chatId)`. SQLite enforces the winning reservation;
  application checks alone are insufficient.
- **INV-2 — Stable shell identity:** clear cannot change Workspace ID, Pane ID,
  terminal ID, Pane token, Pane name/label, Binding ID, Binding generation, or
  Worker ownership.
- **INV-3 — Quiescent clear:** clear cannot begin while any Prompt may still be
  accepted, queued, submitted, running, detached, recovering, or uncertain, or
  while Herdr does not prove the expected Pane is idle and composer-ready.
- **INV-4 — Epoch isolation:** work and projection activity accepted for an old
  epoch cannot mutate the new current Orchestrator view after clear.
- **INV-5 — No replay:** neither Orchestrator provisioning recovery nor clear
  recovery resubmits a Prompt that may already have reached the Agent.
- **INV-6 — Durable external intent:** session rotation intent is persisted
  before Core invocation; Answer-card deletion intent is persisted before Lark
  delivery. Reconciliation repeats only an idempotent operation identity.
- **INV-7 — Bounded authority:** Orchestrator tools resolve targets from durable
  same-project ownership and exact runtime fences; no caller-provided raw Pane
  command or terminal bytes cross the boundary.

`OrchestratorClearOperation` is a dedicated durable operation rather than an
overloaded `SessionOperation`. It records operation ID/idempotency key, actor,
source/confirmation identity, Binding ID/generation, old session epoch, expected
Workspace/Pane/terminal/native-session state, rotation state and receipt, a
snapshot of Answer message targets, per-target delivery settlement, aggregate
counts, detail, and timestamps. Its state machine distinguishes at least
accepted, rotating, rotation-uncertain, context-cleared, withdrawing,
succeeded, partial, rejected, and failed. A duplicate request or confirmation
returns the existing operation/result; it does not create a second rotation.

### Architecture

**ARCH-1 — Configuration and route selection.** The strict project schema gains
an optional strict `orchestrator` object with `enabled` and absolute `cwd`.
Missing/disabled configuration preserves existing root-message behavior.
`ProjectConfig` carries the normalized block. The route index/store owns
lookup/reservation by Gateway/chat and Binding kind. The inbound workflow
continues to resolve Worker Threads, Pane-entry aliases, and explicit commands
before applying the Orchestrator root fallback.

**ARCH-2 — Provisioning reuse.** A dedicated Orchestrator ensure use case reuses
the existing managed Binding provisioning checkpoints, Agent launch, Primary
credential injection, lifecycle events, and prompt admission instead of
creating another Pane lifecycle. It supplies the configured Orchestrator `cwd`,
TraeX kind, singleton reservation key, and fixed Thread semantics. Concrete
Herdr and Lark effects stay behind their existing ports and outbox/effect
gateways.

**ARCH-3 — Tool profile.** Primary tool authentication remains issued by the
runtime gateway and tied to Binding generation plus exact parent Prompt/turn.
The broker recognizes Orchestrator Binding kind and exposes a closed profile:
existing managed Worker create/list/inspect/prompt/follow-up/wait/steer/interrupt
operations plus bounded topology queries needed to list configured Spaces and
their managed/discoverable Panes. Results use normalized internal projections,
not raw `herdr` output. Mutations continue through command/workflow ports and
their authorization/idempotency fences; the MCP client cannot choose a project
outside the Orchestrator's configured project.

**ARCH-4 — Same-Pane rotation port.** The consumer-owned Herdr contract is:

```ts
rotateSession(input: {
  operationId: string;
  paneId: string;
  expectedSession: HerdrAgentSession;
  expectedState: "idle";
  launch: ManagedAgentLaunch;
}): Promise<SessionRotationReceipt>;
```

The concrete adapter may use only a Herdr Core command/API that atomically
checks the exact Pane/terminal/session/state fence, ends the old Agent session,
and starts the configured TraeX launch in that same Pane without recreating or
renaming it. `operationId` is retained by Core so a repeated call returns the
same receipt. Raw escape-key injection, `/new`, shell text, PID killing, and a
close/create Pane sequence are not valid implementations. Capability detection
must reject clear with an actionable unavailable result when the installed Core
does not support this contract.

The Herdr Core capability and its versioned CLI/API contract are an external
delivery dependency. Swarm may add its port, adapter, feature detection, and
tests only against an implemented exact Core contract; it must not simulate
rotation by weakening the fence.

**ARCH-5 — Clear coordination.** The command runtime parses public
`/swarm clear` as an administrator-only Orchestrator-session request and emits a
single-use confirmation. The card action admits the durable operation. A
serial, Binding-scoped dispatcher atomically claims it, reloads authoritative
Prompt state, observes Herdr, and applies INV-2/INV-3 before invoking Core.
After an idempotent rotation receipt, one SQLite transaction advances the
Binding session identity/epoch, resets current-view pointers, records the
receipt/audit fact, snapshots eligible prior Answer message IDs, and enqueues
delete intents. Startup and periodic reconciliation resume nonterminal
operations from durable state.

**ARCH-6 — Typed deletion delivery.** `OutboundReplyKind` and
`DeliveryIntentKind` gain a message-delete variant whose boundary data is the
exact Gateway identity, operation ID, Binding/epoch provenance, and target Lark
message ID. The materializer cannot reinterpret it as a card payload. The Lark
port implements deletion with normalized outcomes: deleted, already absent,
retryable failure, or permanent failure. Existing lane fencing, instance lease,
redaction, bounded retry, and dead-letter mechanics remain authoritative.
Deletion settlement updates the clear operation counts transactionally without
deleting the historical Answer page or outbound records.

Source dependencies continue inward: inbound/CardKit adapters call application
workflows; workflows use domain/store/Herdr/Lark ports; concrete SDK/CLI parsing
stays in adapters; `src/main.ts` assembles implementations. Neither domain rules
nor SQLite store code imports the Lark SDK or executes Herdr commands.

### Behavior & Failure Modes

The lazy ensure identity is the configured Gateway/chat, not source text. The
initial project selection and Prompt retain the Lark event/message idempotency
keys. A concurrent loser resolves the durable winner only after the winner's
reservation is visible. If the winner is still provisioning, later root
requests publish the same bounded initializing/entry feedback and do not take
over its Pane.

Clear admission and execution both check quiescence to close the race between a
confirmation card and a new Prompt. Once an operation is claimed for rotation,
new ordinary Prompt admission for that Binding is refused until the operation
reaches a terminal context state. Commands that only query status may continue;
no Worker state is frozen or changed.

An expected-fence rejection is terminal and mutation-free. A Core transport
failure before dispatch is retryable under the same operation ID. A timeout or
disconnect after possible dispatch is uncertain; reconciliation must obtain the
same receipt or an authoritative non-effect response. A confirmed Core success
is never compensated by restarting the old session.

After context-cleared is durable, Lark withdrawal is best-effort but durable.
The operation's user-visible result is `succeeded` when all targets are deleted
or already absent and `partial` when one or more terminal deletions fail. The
result reports exact counts without exposing card contents. An empty target set
is a successful clear with zero deletions.

### Compatibility & Migration

SQLite migration adds Binding kind/epoch, Orchestrator clear state, required
indexes/triggers, and deletion provenance additively. Existing Bindings and
Prompts are restored as task/epoch 1 without replaying lifecycle operations.
Existing task uniqueness, Pane ownership, Worker parent-generation rules,
outbox rows, Answer history, and archived Binding lookup remain intact.

The project configuration addition is optional so existing registries still
validate. Once enabled, only the default project's unbound-root fallback changes
to fixed Orchestrator behavior. Explicit `/swarm new`, existing Threads, and
disabled projects keep current behavior. Setup/config summary and validation
show the Orchestrator route without printing credentials.

The live `projects.json` update is sequenced after installing a compatible
release because the currently running strict schema does not accept the new
field. Installation, configuration mutation, validation, service restart, and
live smoke verification each remain outside coding approval and require the
later explicit operational gate.

## Testing Decisions

- Map SCN-1/SCN-2 and INV-1/INV-5 to config, inbound routing, provisioning, and
  integration tests: disabled compatibility; first allowed-user bootstrap;
  duplicate event; concurrent roots; provisioning recovery; first-Prompt
  exactly-once; fixed-thread no-mention FIFO; later root entry response; and
  unchanged task/alias/Worker routing.
- Exercise the real SQLite migration/store seam for Binding kind/epoch and the
  singleton partial uniqueness constraint. Reopen the database, resolve the
  same Orchestrator, and prove historical task rows remain task Bindings.
- Map SCN-3 and INV-7 to Primary tool gateway/broker/MCP contract tests:
  Orchestrator profile exposure, normalized topology queries, same-project
  target enforcement, stale generation/session/parent-turn refusal, duplicate
  idempotency behavior, and absence of raw terminal/approval/kill tools.
- Map SCN-4/SCN-5 and INV-2/INV-3/INV-4 to command parser/policy, confirmation,
  clear workflow, store, and Herdr adapter tests. Cover unauthorized/non-
  Orchestrator/stale confirmation, every nonterminal Prompt class, detached
  observation, non-idle/composer-not-ready runtime, lost identity fences,
  success, and a post-clear Prompt. Assert before/after Workspace, Pane,
  terminal, token, label, Binding generation, and Worker identity while native
  session and epoch alone change.
- At the real SQLite seam, save/reopen a context-cleared Binding and operation,
  then attempt old-epoch dispatch/projection to prove it cannot mutate the new
  Main/Answer view. Verify controlled restoration does not emit lifecycle events
  or repeat rotation.
- Map SCN-6 and INV-6 to outbox, materializer, dispatcher, Lark adapter, and
  operation settlement tests: target snapshot completeness; exact message IDs;
  delete success; already absent; retryable, permanent, exhausted, duplicate,
  and mixed outcomes; exact counts; no historical-row deletion; no deletion of
  Main/task/Worker cards; no rollback of the new context.
- Map SCN-7 to crash-boundary integration tests before Core dispatch, after
  possible dispatch, after receipt/before SQLite commit, after epoch commit, and
  during deletion. Repeated dispatch must use the same operation ID and converge
  without Prompt replay or a second session rotation.
- Add Herdr adapter contract tests against captured supported/unsupported Core
  responses. Separately review imports and composition to prove SDK/CLI types do
  not leak into domain/workflow modules.
- Before delivery run focused affected tests, `npm run typecheck`,
  `npm run build`, and the full `npm test` suite. Live smoke, installation,
  configuration edit, and restart are not part of automated delivery.

## Out of Scope

- Adopting or credentializing an already-running Primary Pane discovered
  directly in Herdr; the existing TODO remains authoritative for that work.
- Clearing task Primary or Worker contexts; `/swarm clear` is Orchestrator-only.
- Deleting SQLite Prompt, transcript, projection, outbox, audit, or operation
  history.
- Deleting the fixed Thread, Orchestrator Main Card, task cards, Worker cards,
  or the Pane itself.
- Changing Pane ID/token/name/label, Binding generation, Worker ownership, or
  project/workspace routing during clear.
- Arbitrary shell or terminal input, raw process/PID controls, remote approval
  bypass, unsafe Pane retargeting, automatic deployment, Git push, or live
  configuration mutation.
- Guaranteeing that Feishu permits deletion of every historical Answer Card;
  exact partial results are the required behavior.
- Removing or repurposing existing task Primary creation and management flows.

## Further Notes

The approved design is the extended-Binding approach. No unresolved domain
decision blocks specification review. Delivery does have one explicit external
dependency: Herdr Core must provide the exact/idempotent same-Pane rotation
contract in ARCH-4 before `/swarm clear` can be enabled end to end.

Workspace mode changed from isolated to in-place during baseline setup. The
prepared worktree
`/workspace/herdr-agent-swarm/.trae/worktrees/fix-group-orchestrator`
is mounted read-only at `.trae`, so even `mkdirSync(..., {recursive:true})`
failed for `.cache/ts-build-output`. The main checkout is writable and the
task-owned paths can be separated from its pre-existing changes, so planning
continues in place on branch `main` at starting revision
`96fe111c15475303b5a86799316e76b06f62774f`.

Pre-existing main-checkout changes are preserved: the task-related uncommitted
`TODO.md` item for direct-Pane Primary adoption, and unrelated untracked
`.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md`. They are not part of this specification's eventual ticket commits
unless separately authorized and explicitly selected.

Fresh baseline evidence on 2026-10-02, before this specification was written:

```text
npm run build && npm test && npm run typecheck
Test Files  236 passed (236)
Tests       3319 passed (3319)
build       passed
typecheck   passed
```

Gate 1 design approval and Gate 2 specification approval are recorded in the
conversation. No implementation, install, live configuration change, service
restart, deployment, push, or external publication is authorized by Gate 2.
