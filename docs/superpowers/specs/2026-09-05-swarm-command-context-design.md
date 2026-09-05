# Swarm Command Bounded Context

## Status

Approved design. This document defines the migration of every `/swarm` command
through one domain boundary and fixes Worker creation against a Primary whose
terminal identity and native Agent session identity are both persisted.

## Problem

`InboundMessageRoutingWorkflow` currently parses, authorizes, scopes, dispatches,
and formats results for the complete `/swarm` command set. Mutation durability is
split across several workflow-specific tables and some commands execute directly
from the inbound callback. CardKit Worker creation follows another path. The
result is duplicated policy, inconsistent idempotency and recovery, and no single
place that states which durable context a command is allowed to affect.

Worker creation also mixes two independent runtime identities. It compares a
live native Agent session ID, selected ahead of the terminal ID, with the
binding's persisted terminal ID. A healthy Primary is therefore rejected when
both identities exist. The production `task-di58` case has matching pane,
workspace, cwd, terminal ID, and native Agent session, but the cross-kind string
comparison reports `Worker parent pane identity changed`.

## Decision

Introduce a `Swarm Command` bounded context. Every `/swarm` text command enters
through one gateway that parses the request, resolves an explicit context,
evaluates policy, and dispatches either a query or a durable mutation. Existing
Binding, Prompt, Worker, Pane Control, Session Administration, Provisioning, and
Delivery contexts retain their aggregate authority. The command context
orchestrates them through narrow handler interfaces and never copies their state.

The existing `/instances` CardKit Worker creation form is an additional adapter
into the same Worker-create command handler. The legacy non-`/swarm` instance
commands remain supported and are not otherwise migrated in this change.

## Command language

All existing syntax remains valid. This change adds:

```text
/swarm worker create <name>
  [--agent traex|codex|claude-code|pi]
  [--model <name>]
  [--start]
```

Defaults are `--agent traex`, no explicit model, and persisted-but-not-started.
Names retain the existing `[a-z][a-z0-9_-]{0,31}` constraint. Unknown options,
duplicate options, missing values, extra positional arguments, or an invalid
Agent kind produce help or a deterministic validation error without creating a
command intent.

## Domain model

### CommandRequest

`CommandRequest` is the normalized input produced by either the Lark text adapter
or the CardKit adapter. It contains the parsed command, source identity, actor,
and reply target. After this conversion, handlers do not branch on the original
transport.

### SwarmCommandContext

`SwarmCommandContext` is an immutable value object resolved at acceptance. It
has one of four scopes:

| Scope | Examples | Frozen facts |
| --- | --- | --- |
| Global | `projects`, `new`, `help` | chat, actor, source message |
| Project | `spaces`, `attach` | global facts plus project and workspace |
| Primary session | `status`, `reset`, `worker create` | binding ID/generation, project, pane, terminal and native session identities |
| Active turn | `stop`, `awake` | Primary session plus exact prompt/turn identity when present |

The resolver reads current durable state once and produces either a valid context
or a typed rejection. A handler revalidates all relevant aggregate versions and
runtime ownership before an external side effect. Frozen facts are fences, not a
second source of aggregate truth.

### CommandIntent aggregate

Only mutations create a `CommandIntent`. It owns:

```text
commandId / idempotencyKey
command kind and validated payload
actor and source identity
frozen SwarmCommandContext
state and attempt count
terminal outcome metadata
created/claimed/updated timestamps
```

It does not own Binding, Prompt, Worker, pane, card, or outbox state. References
to those aggregates are generation-fenced identifiers.

The lifecycle is:

```text
received -> accepted -> executing -> succeeded
                              |---> rejected
                              |---> failed
                              `---> uncertain
```

`received` exists only at the adapter boundary. Acceptance and durable insertion
are one operation. A rejected request that never became an intent is returned
directly and audited.

### CommandPolicy

The policy is a pure registry keyed by command kind. Each entry declares:

- query or mutation;
- required context scope;
- administrator and/or binding-creator requirement;
- replay policy;
- owning handler.

Adding a command without a policy entry is a compile-time or exhaustive-test
failure. Authorization does not live in routing conditionals.

## Command inventory and ownership

| Command | Kind | Scope | Authorization | Owning handler/context |
| --- | --- | --- | --- | --- |
| `help` | query | global | allowed user | help projection |
| `projects` | query | global | administrator | provisioning query |
| `spaces` | query | project/global selection | allowed user | operations query |
| `sessions` | query | global chat | allowed user | operations query |
| `failures` | query | global chat | allowed user | operations query |
| `status` | query | Primary session | allowed user | session query |
| `model` | query | Primary session | creator + administrator | model query |
| `new [title]` | mutation | global | administrator | binding provisioning |
| `reset [title]` | mutation | Primary session | creator + administrator | binding provisioning |
| `attach <space> <pane>` | mutation | project | administrator | binding provisioning |
| `rename <title>` | mutation | Primary session | creator + administrator | session administration |
| `close` | mutation | Primary session | creator + administrator | session administration |
| `pane close` | mutation | Primary session | creator + administrator | pane closure |
| `pane close confirm <code>` | mutation | Primary session | creator + administrator | pane closure |
| `reattach <pane>` | mutation | Primary session | creator + administrator | binding provisioning |
| `replace` | mutation | Primary session | creator + administrator | binding provisioning |
| `resume` | mutation | Primary session | creator + administrator | session administration |
| `awake` | mutation | active turn | creator | prompt recovery |
| `stop` | mutation | active turn | creator + administrator | pane control |
| `steer <text>` | mutation | active turn | administrator | pane control; currently durable rejection |
| `model <name>` | mutation | Primary session | creator + administrator | model selection |
| `worker create ...` | mutation | Primary session | administrator | Worker lifecycle |

The table is the migration manifest. Tests enumerate the parsed command union and
fail if any command lacks a policy and dispatcher route.

## Query and mutation execution

Queries pass through the same parser, context resolver, and policy evaluator but
do not create command rows. They synchronously read the owning context's durable
projection, enqueue their reply through the existing outbound interface, and
write structured audit.

Mutations follow this flow:

```text
Lark text or CardKit action
          |
          v
SwarmCommandGateway
  parse -> resolve -> authorize
          |
          v
atomic accept CommandIntent
          | durable-before-wake
          v
SwarmCommandDispatcher
  claim -> revalidate -> handler
          |
          v
terminal outcome + durable reply intent
```

Commands that mutate the same Primary session execute serially by binding lane.
Global/project topology mutations use a stable project or chat lane. Independent
Primary sessions remain concurrent.

## Idempotency and recovery

Text idempotency keys are `lark-message:<messageId>:<command-kind>`. CardKit
Worker creation keys combine the card message, operator, and a SHA-256
fingerprint of the normalized Worker-create command. Repeating the same form
submission returns or reprojects the existing outcome and never invokes the
owning handler twice, while a later submission from the same directory card can
create a different Worker without colliding with the first request.

Each mutation policy declares one of:

- `safe-before-effect`: an accepted command may be claimed; a crash after claim
  becomes uncertain unless the handler proves no effect occurred;
- `reconcilable`: an uncertain command is resolved by an operation-specific
  reconciliation path against its owning aggregate and Herdr;
- `non-replayable`: uncertainty is terminal and requires explicit user action.

At startup, `accepted` commands become eligible work. Stale `executing` commands
become `uncertain`; they are never blindly replayed. Existing specialized
operation tables remain the durable authority for commands already owning a
deeper workflow state machine. The command intent stores their operation
reference and mirrors only the orchestration outcome.

## Result delivery

The command aggregate records a transport-neutral outcome. User-visible results
are projections delivered through the existing SQLite outbox. The terminal
command transition and result delivery intent are committed atomically wherever
the owning context can provide that transaction. Where an existing specialized
workflow already owns an atomic result intent, the command records the durable
operation reference and the result projector converges from that authority.

No retry of a Lark reply may repeat a command or Herdr side effect.

## Worker creation and dual runtime identity

Worker creation requires an active, attached Primary binding and a fresh Herdr
observation. Runtime identity consists of independent dimensions:

```text
binding.paneId             == pane.paneId
binding.workspaceId        == pane.workspaceId
project.cwd                == pane.cwd
binding.traexSessionId     == pane.terminalId
binding native session     == pane.agentSession
```

Terminal identity is never compared to native Agent session value. When both
native identities exist, source, normalized agent, kind, and value must match.
Known reporter-source aliases that describe the same Herdr TraeX reporter are
normalized at the adapter/domain boundary; arbitrary sources are not treated as
equivalent. When the binding has only a legacy terminal identity, matching pane,
workspace, cwd, and terminal are sufficient, and normal reconciliation may add
the observed native identity. Missing or conflicting persisted identity fails
closed.

The exact verified Primary identity is copied into the Worker's immutable parent
reference. Creation persists the Worker before optional provisioning. The
existing project-wide capacity limit and Primary-scoped name uniqueness remain
unchanged.

The CardKit create form and `/swarm worker create` share normalization, context,
policy, idempotency, handler, and outcome projection. They cannot drift into two
creation semantics.

## Integration shape

`InboundMessageRoutingWorkflow` retains only top-level discrimination:

```text
/swarm command       -> SwarmCommandGateway
legacy instance cmd  -> InstanceInteractionWorkflow
ordinary message     -> Prompt acceptance/routing
```

The command gateway depends on capability-focused handler interfaces, not the
concrete SQLite store or transport SDK. `SqliteBindingStore` implements the
command intent port and preserves atomic transitions. The composition root wires
the gateway, dispatcher, notifier, and existing workflows. Shutdown waits for
claimed command work to settle or be detached to uncertainty.

## Error semantics

- Parse and policy failures are deterministic rejections and have no command row.
- A stale binding, generation, pane, or runtime identity becomes `rejected`.
- A confirmed failure before any external effect becomes `failed`.
- A timeout or crash after an external effect may have begun becomes `uncertain`.
- Error messages pass through existing safe-error redaction.
- User replies name the command and recovery action without exposing another
  Primary's existence or runtime details.

## Migration and compatibility

Add a forward-only SQLite migration for command intents and indexes. Startup is
idempotent. Existing specialized command/operation rows are not rewritten. There
is no attempt to infer historical command intents from old messages.

Existing `/swarm` syntax, permissions, visible replies, and workflow semantics
remain compatible except for the added Worker-create command and corrected
Primary identity acceptance. `/instances`, `/project`, `/instance`, `/to`,
`/steer`, and `/interrupt` remain available.

## Verification

Tests must prove:

1. Every `BridgeCommand` variant has a policy and route.
2. Parser coverage includes all old syntax and Worker-create valid/invalid forms.
3. Each command resolves the declared scope and authorization.
4. Query commands create no command intent.
5. Mutation duplicates execute once and reproduce their durable result.
6. Stale binding generation, pane, terminal, and native session fail closed.
7. Startup reclaims `accepted`, terminalizes stale `executing` as uncertain, and
   never blindly replays an uncertain command.
8. Text and CardKit Worker creation are behaviorally equivalent.
9. The `task-di58` identity shape succeeds: terminal matches terminal, native
   tuple matches native tuple, and native value differs from terminal ID.
10. Genuine terminal or native-session replacement remains rejected.
11. Existing per-command integration tests remain green.
12. Typecheck, build, documentation audit, and full Vitest suite pass.

## Non-goals

- Migrating legacy non-`/swarm` instance commands beyond Worker-create CardKit.
- Replacing the business aggregates or specialized operation state machines.
- Adding remote approval or force-stop capabilities.
- Automatically retrying uncertain external effects.
- Changing Worker capacity, naming, worktree, or session-generation semantics.
