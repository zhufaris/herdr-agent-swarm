# Solo Agent Product Design

**Ticket:** [Solo Agent Product](../tickets/2026-08-28-solo-agent-product.md)

## Purpose

This document specifies a standalone, human-controlled multi-agent product built
on Herdr's headless runtime and the bridge's durable workflow foundation. It is
written for an engineer implementing the migration from the existing
single-TraeX-topic bridge. After reading it, that engineer should be able to
implement each delivery slice without needing the design conversation.

The product manages multiple projects. Each project may have one primary agent
instance and several worker instances. A human explicitly creates the topology,
chooses each runtime, assigns the primary, and chooses the target of a message.
The primary may coordinate already-created workers in the same project. The
product does not automatically invent work, create workers, or continue a
workflow when a worker finishes.

## Product boundary

Herdr is a mandatory headless runtime, not the user interface. It owns live
workspace, pane, terminal, foreground-process, and detected-agent facts. The
product owns projects, instance roles, desired lifecycle, message queues,
workspace leases, approvals, audit, projections, and delivery intent in SQLite.
Feishu is an ingress and presentation gateway only. Git owns repository content,
branches, commits, and dirty-state facts.

```text
Feishu cards and messages       Local operator commands
             |                           |
             +------ product control ----+
                            |
                    durable SQLite state
                            |
             +--------------+---------------+
             |                              |
      instance workflows              Feishu outbox
             |
      headless runtime module
             |
       Herdr pane host
             |
   Pi / Claude Code / Codex / TraeX
```

The supported deployment is one fenced product daemon and one Herdr headless
server on the same host. The optional Herdr plugin remains an operator surface,
not a runtime prerequisite.

## Domain model

### Project

A project is a configured repository and execution scope. It has a stable ID,
display metadata, an absolute repository root, a Herdr workspace, a policy
profile, an instance limit, and an optional current primary instance. Project
IDs are unique and lowercase. Repository roots and Herdr workspaces cannot be
silently shared by unrelated projects.

```ts
interface Project {
  id: string;
  displayName: string;
  description: string;
  repositoryRoot: string;
  herdrWorkspaceId: string;
  policyProfile: string;
  maxInstances: number;
  primaryInstanceId: string | null;
}
```

### Agent instance

Primary and worker use the same instance model. Role is a product assignment,
not an agent implementation. A runtime is eligible for the primary role only if
its driver supports the required controlled-worker tools.

```ts
type AgentKind = "pi" | "claude-code" | "codex" | "traex";
type InstanceRole = "primary" | "worker";
type DesiredInstanceState = "running" | "stopped";
type ObservedInstanceState =
  | "unprovisioned"
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "detached"
  | "stopped"
  | "failed";

interface AgentInstance {
  id: string;
  projectId: string;
  name: string;
  role: InstanceRole;
  agentKind: AgentKind;
  model: string | null;
  desiredState: DesiredInstanceState;
  observedState: ObservedInstanceState;
  workspaceLeaseId: string;
  generation: number;
  runtimeRef: RuntimeRef | null;
}
```

Every project has at most one primary. The primary uses the project's main
checkout by default. A writable worker uses one platform-created branch and Git
worktree. Instances are durable and do not disappear when a turn completes.
Moving an instance to a new pane or native agent session increments its
generation. Stale observers, commands, and tool grants cannot mutate a newer
generation.

### Conversation binding and target

A Feishu topic binds to a project and a default target. `primary` is a symbolic
target that follows a later primary change. An explicit instance target remains
fixed. A one-shot directed message does not mutate the default target.

```ts
interface ConversationBinding {
  id: string;
  chatId: string;
  topicId: string;
  rootMessageId: string;
  projectId: string;
  defaultTarget:
    | { kind: "primary" }
    | { kind: "instance"; instanceId: string };
}
```

### Turn and operation

A turn is one FIFO message submitted to a target instance. An operation is an
audited control request such as start, stop, steer, interrupt, primary change,
or removal planning. Every request carries an idempotency key and a trusted actor
identity supplied by the gateway, primary tool broker, or local operator.

```ts
type TurnState =
  | "queued"
  | "claimed"
  | "dispatching"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "dispatch-uncertain";

type MessageActor =
  | { kind: "human"; userId: string; channel: "feishu" | "local" }
  | {
      kind: "primary-agent";
      projectId: string;
      instanceId: string;
      generation: number;
      parentTurnId: string;
    };
```

Each instance runs at most one ordinary turn. Different instances may run in
parallel. Steering is explicit and only targets a currently active turn; it
never falls back to an ordinary queued turn. A worker completion changes durable
state and visible projections but creates no primary turn.

### Workspace lease

```ts
interface WorkspaceLease {
  id: string;
  projectId: string;
  instanceId: string;
  kind: "main-checkout" | "git-worktree" | "shared-read-only";
  cwd: string;
  branch: string | null;
  baseCommit: string;
  state:
    | "allocating"
    | "ready"
    | "dirty"
    | "committed"
    | "conflicted"
    | "release-requested"
    | "retained"
    | "released";
  generation: number;
}
```

The base ref is resolved to a commit before allocation. One writable worktree
belongs to one worker. Stopping an instance never deletes its worktree. Runtime
removal and workspace cleanup are separate requests. Dirty, conflicted,
unmerged, or uncertain worktrees default to retained. The product never
automatically merges, cherry-picks, pushes, or deploys.

## Application interfaces

### Human instance control

Feishu commands, Feishu cards, and the local operator CLI invoke the same
application module. No gateway contains lifecycle policy.

```ts
interface InstanceControlService {
  create(actor: HumanActor, input: CreateInstance): Promise<InstanceReceipt>;
  setPrimary(actor: HumanActor, projectId: string, instanceId: string): Promise<OperationReceipt>;
  start(actor: HumanActor, instanceId: string): Promise<OperationReceipt>;
  stop(actor: HumanActor, instanceId: string): Promise<OperationReceipt>;
  planRemoval(actor: HumanActor, instanceId: string): Promise<RemovalPlan>;
  confirmRemoval(actor: HumanActor, planId: string): Promise<OperationReceipt>;
  inspect(actor: HumanActor, instanceId: string): Promise<InstanceView>;
  list(actor: HumanActor, projectId: string): Promise<InstanceView[]>;
}
```

Only a human may create, remove, promote, or retarget instances in the MVP.
Removal always begins with a plan containing Git evidence. A plan becomes stale
if the pane generation, worktree state, branch head, or dirty paths change.

### Instance messaging

```ts
interface InstanceMessagingService {
  submit(input: {
    idempotencyKey: string;
    actor: MessageActor;
    projectId: string;
    targetInstanceId: string;
    content: { kind: "turn" | "followup"; text: string };
  }): Promise<TurnReceipt>;

  steer(input: {
    idempotencyKey: string;
    actor: MessageActor;
    targetInstanceId: string;
    text: string;
  }): Promise<SteeringReceipt>;

  interrupt(input: {
    idempotencyKey: string;
    actor: MessageActor;
    targetInstanceId: string;
  }): Promise<OperationReceipt>;

  inspect(actor: MessageActor, instanceId: string): Promise<InstanceConversationView>;
}
```

The service validates actor, project membership, target generation, queue depth,
and driver capability before changing state. It durably accepts work before
waking an executor. A successful receipt means accepted, not executed.

### Primary worker tools

The primary receives a fixed, business-level tool set:

```ts
interface PrimaryWorkerTools {
  listInstances(input?: { state?: ObservedInstanceState }): Promise<InstanceSummary[]>;
  promptInstance(input: { instanceId: string; task: string; idempotencyKey: string }): Promise<TurnReceipt>;
  followUpInstance(input: { instanceId: string; text: string; idempotencyKey: string }): Promise<TurnReceipt>;
  steerInstance(input: { instanceId: string; text: string; idempotencyKey: string }): Promise<SteeringReceipt>;
  inspectInstance(input: { instanceId: string }): Promise<InstanceConversationView>;
  waitInstance(input: { instanceId: string; afterCursor?: string; timeoutMs?: number }): Promise<InstanceEventPage>;
  interruptInstance(input: { instanceId: string; idempotencyKey: string }): Promise<OperationReceipt>;
}
```

The broker derives project, primary identity, generation, and parent turn from a
trusted runtime credential. Model-supplied values cannot override them. The
primary may call existing workers in its project without per-call approval. It
cannot call another project or receive create, remove, promote, worktree, raw
Herdr, or raw shell tools.

## Runtime interfaces

Pane hosting and agent protocol are separate seams. Herdr supplies the production
pane host. Each agent driver owns only the protocol of one agent family.

```ts
interface PaneHost {
  ensureWorkspace(project: Project): Promise<WorkspaceHandle>;
  allocatePane(input: PaneAllocation): Promise<PaneHandle>;
  inspectPane(paneId: string): Promise<PaneObservation>;
  observePane(paneId: string, cursor?: string): AsyncIterable<PaneObservation>;
  interruptPane(paneId: string): Promise<void>;
  releasePane(paneId: string): Promise<void>;
}

interface AgentRuntimeDriver {
  readonly kind: AgentKind;
  describe(): AgentCapabilities;
  buildLaunchSpec(input: LaunchContext): LaunchSpec;
  detect(observation: PaneObservation): AgentDetection;
  submit(runtime: RuntimeRef, turn: TurnEnvelope): Promise<DispatchReceipt>;
  steer(runtime: RuntimeRef, text: string): Promise<SteerResult>;
  interrupt(runtime: RuntimeRef): Promise<InterruptResult>;
  normalize(observation: PaneObservation): AgentObservation[];
}

interface AgentCapabilities {
  available: boolean;
  structuredEvents: boolean;
  nativeResume: boolean;
  primaryTools: boolean;
  steering: "native" | "terminal-input" | "unsupported";
  interrupt: "native" | "terminal-signal";
  approvals: "structured" | "terminal" | "none";
  modelSelection: "startup-only" | "runtime" | "unsupported";
  usageReporting: boolean;
}
```

Unsupported features produce an explicit result and are absent from cards. They
never silently degrade into a different operation. An adapter is available only
after its executable and required integration are validated. TraeX is extracted
first as the reference adapter, followed by Codex, Claude Code, and Pi. Shared
terminal parsing is allowed only for common framing; each driver owns its
identity and protocol markers.

### Dispatch contract

```ts
type DispatchReceipt =
  | { status: "confirmed-delivered"; runtimeCursor?: string }
  | { status: "not-delivered"; reason: string }
  | { status: "delivery-uncertain"; reason: string };
```

Before an external write, the executor persists a claim and dispatch intent. A
confirmed delivery moves the turn to running. A confirmed non-delivery may be
failed or safely requeued by an explicit transition. An uncertain delivery moves
the turn to `dispatch-uncertain`, detaches its observer, and forbids automatic
replay.

## Lifecycle and recovery

Instance desired state and observed state are independent. A running instance
whose pane disappears remains desired-running but becomes detached. A stopped
instance is not recreated. Reprovisioning increments generation before a new
runtime may accept work.

Worker provisioning is a durable saga:

1. Record the instance and workspace allocation intent.
2. Validate repository ownership, base commit, branch, and target path.
3. Create the worktree and checkpoint its lease.
4. Allocate a Herdr pane with the lease cwd.
5. Launch the selected driver.
6. Verify pane, process, and agent identity.
7. Attach the runtime with a new generation and mark the instance idle.
8. Create the Feishu projection intent.

Each completed external effect has an explicit checkpoint. Recovery continues
from checkpoints and never restarts the saga from assumption.

Startup recovery runs in this order:

1. Acquire the fenced daemon lease.
2. Validate schema and durable references.
3. Load desired-running instances and unfinished turns and operations.
4. Read a fresh Herdr snapshot.
5. Reassociate using workspace, pane, process identity, native session identity,
   and generation.
6. Resume observers for working, blocked, detached, and uncertain turns.
7. Wake only queued work that is known never to have started.
8. Recreate missing Feishu delivery intent from durable desired views.
9. Start periodic reconciliation, then advertise readiness.

Herdr events are bounded wake-up hints. Every decision reloads authoritative
SQLite and fresh Herdr facts. An unrecorded pane is never automatically adopted.

## Persistence and transaction boundaries

SQLite remains the single local transaction owner. The target schema adds or
generalizes these durable records:

```text
projects
agent_instances
workspace_leases
conversation_bindings
turns
turn_deliveries
instance_observation_cursors
instance_events
operations
approval_requests
approval_grants
audit_records
conversation_views
answer_pages
outbox_items
outbox_delivery_attempts
instance_leases
schema_migrations
```

This is not complete event sourcing. State tables remain authoritative. Bounded
instance events and audit rows explain decisions and support projections. Full
terminal buffers, model reasoning, and unbounded token streams are not retained.

The following writes are atomic:

- Inbound acceptance: dedupe the inbound event, insert the turn, update queue
  state and desired view, and create the outbox intent.
- Turn claim: verify instance generation and absence of another ordinary turn,
  claim the oldest eligible turn, and save the dispatch checkpoint.
- Turn completion: finish the turn, clear the active turn, update instance and
  bounded result state, update views, and create outbox intent.
- Primary control: verify trusted primary project and generation, persist the
  operation, mutate the target queue or control state, and audit the parent turn.
- Approval: verify action fingerprint, actor, scope, and expiry, resolve the
  request, create a single-use grant, and resume only the exact operation.

Process-local notifications only wake workers. Feishu delivery starts after
commit and uses the durable outbox. A delivery retry cannot repeat a turn.

### Migration from bindings

Existing bindings remain readable throughout migration. The first compatibility
step interprets every current binding as a TraeX instance and preserves its
project, pane, generation, queue, cards, and native session identity. New
instance tables are introduced additively. Workflows migrate behind interfaces
before old columns or paths are retired. No migration sends an agent prompt.

The migration is complete only after startup reconciliation proves that legacy
and new rows converge to the same visible state and no active or uncertain turn
is duplicated. Obsolete runtime fields may be removed only in a later cleanup
after production evidence shows no legacy readers.

## Feishu interaction

The project card shows the current primary, current message target, named
instances, agent kinds, states, queue depth, approval count, and worktree count.
Instance detail shows model, role, Herdr identity, generation, cwd, branch, base
commit, Git disposition, active turn, queue, recent result, and only the controls
supported by that driver.

The compact command surface is:

```text
/projects
/project <id>
/instances
/instance <name>
/to <name> <message>
/steer <name> <message>
/interrupt <name>
```

Instance creation, removal, primary assignment, agent/model selection, worktree
configuration, and persistent target selection use CardKit forms. Commands and
cards call the same application services. If no primary exists, ordinary input
opens the instance directory instead of choosing one automatically.

Answer pagination remains a rendering transform. Canonical answer offsets stay
durable, frozen pages are not patched, and long content continues in a new card.
Cards are projections and are never parsed to reconstruct workflow state.

## Authorization and approvals

The MVP uses three fixed risk tiers:

- `routine`: configured workspace reads/writes, local project tests, and a
  primary coordinating an existing same-project worker.
- `remote-confirmation`: explicitly configured, auditable external effects that
  the owner may approve from Feishu.
- `local-only`: push, deployment, deletion, credential access, permission bypass,
  sensitive host paths, destructive commands, and unstructured native agent
  approvals.

Approval identity binds actor, project, instance generation, canonical action
fingerprint, resource scope, policy version, expiry, and a single-use flag. Any
change invalidates the approval. Feishu can display local-only blockers but
cannot resolve them.

Inbound Feishu access retains configured-chat and configured-operator allowlists.
Secrets remain in private environment or plugin configuration and never enter
project configuration, audit rows, terminal projections, or cards. All terminal
and agent output passes through bounded redaction before persistence or delivery.

## Configuration and deployment

Configuration declares product server settings, Herdr session, Feishu identity
and allowlists, projects, and initial instances. The schema validates absolute
repository roots, unique project and instance names, project instance limits,
one primary, supported agents, model compatibility, and worktree ownership.

The user systemd deployment runs a headless Herdr server and the product daemon.
The daemon owns the Feishu long connection, health endpoints, reconciler, prompt
workers, SQLite lease, and outbox dispatcher. `/health` means the process
responds. `/ready` additionally requires the daemon lease, valid projects,
reachable Herdr, initialized adapters, SQLite integrity, and usable Feishu
credentials.

The Herdr plugin remains optional for status, logs, setup, and restart. Production
startup and restart must verify the generated build identity before accepting
work.

## Failure behavior

- Adapter unavailable: reject start with an actionable capability report; do not
  create a fake running instance.
- Unsupported steer or model change: return `unsupported`; do not queue another
  turn or restart implicitly.
- Pane missing with no active turn: retain the instance and allow an explicit or
  desired-state recovery to provision a new generation.
- Pane missing with active or uncertain work: detach or fail observation without
  replaying input.
- Worktree creation partly succeeds: retain the allocation checkpoint and inspect
  Git before retry or compensation.
- Worktree cleanup cannot prove safety: retain it and show the evidence needed for
  manual review.
- Feishu failure: retry or dead-letter only the outbox item.
- Lease loss: stop accepting and claiming work; do not release ownership resources
  until write-capable tasks have settled or detached.

## Verification and acceptance matrix

### Domain and configuration tests

- Multiple projects and unique routes validate.
- A project rejects multiple primaries, duplicate instance names, invalid agent
  kinds, relative repository roots, and excess instances.
- Primary same-project calls pass; cross-project, stale-generation, and worker-as-
  primary calls fail.
- Driver capabilities control visible and callable actions.
- Risk classification and action fingerprints are deterministic.
- Removal plans retain dirty, conflicted, uncertain, and unmerged worktrees.

### Workflow integration tests

- A human creates a worker; worktree allocation, pane launch, driver detection,
  durable instance state, and card intent converge.
- Human and primary turns share per-instance FIFO while separate instances run in
  parallel.
- A primary lists, prompts, follows up, inspects, waits, steers, and interrupts an
  existing same-project worker.
- Worker completion never creates a primary turn.
- Unsupported steering remains unsupported.
- Uncertain dispatch detaches and is not replayed across restart.
- Generation fencing rejects late observer and tool writes.
- Startup restores primary and worker observers and wakes only known-queued work.
- Outbox retry does not create another agent turn.
- Removal requires a current safe plan and never deletes an unsafe worktree.

### Driver contract tests

Each available driver passes the same suite for executable validation, launch
specification, identity detection, lifecycle normalization, submit receipt,
bounded answer extraction, secret redaction, declared steer behavior, interrupt,
restart reconciliation, and uncertain delivery. A driver not exercised by the
suite remains unavailable.

### Headless operational acceptance

Without opening the Herdr TUI:

1. Start an isolated Herdr server and the product daemon.
2. Configure one repository project and a primary.
3. Explicitly create two workers using different available agent drivers.
4. Send concurrent read-only tasks to both workers.
5. Have the primary call one existing worker and read its result.
6. Confirm that the other worker's completion does not trigger the primary.
7. Restart the daemon and verify instances, queues, observers, and cards recover.
8. Exercise one Feishu-approved operation and one local-only blocker.
9. Stop instances and verify dirty worktrees are retained.
10. Confirm logs and SQLite contain no duplicate dispatch or cross-project access.

Every adapter claimed as supported must also complete one real headless smoke
turn. The release gate includes focused tests, the full Vitest suite, TypeScript
typecheck, production build, configuration validation, readiness, build identity,
and a requirement-to-evidence audit.

## Non-goals

The MVP does not automatically decompose requests, create workers, choose agents
or models, feed worker results to the primary, merge branches, push, deploy,
clean uncertain worktrees, schedule workers across hosts, provide multi-tenant
billing, implement a plugin marketplace, event-source every observation, replace
the Herdr TUI, or remotely resolve every native agent approval.
