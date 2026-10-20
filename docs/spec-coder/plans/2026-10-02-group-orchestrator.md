# Group Orchestrator Binding and Context Clear Plan

Specification:
[`docs/spec-coder/specs/2026-10-02-group-orchestrator.md`](../specs/2026-10-02-group-orchestrator.md)

Workspace: in-place in
`/workspace/herdr-agent-swarm`, branch `main`, starting revision
`96fe111c15475303b5a86799316e76b06f62774f`. The prepared `.trae` worktree is
read-only and cannot produce build output. Existing `TODO.md` and unrelated
untracked paths listed in the specification are preserved and excluded from
ticket commits.

Baseline:

```text
npm run build && npm test && npm run typecheck
Test Files  236 passed (236)
Tests       3319 passed (3319)
```

Gate 1 design and Gate 2 specification are approved. This ticket set is pending
Gate 3 approval and implementation authorization. Every completed ticket gets
one task-scoped Conventional Commit. No ticket authorizes installation, live
configuration changes, restart, deployment, push, or external publication.

## Dependency Map

```text
T1 Fixed Orchestrator binding ------> T2 Orchestrator tool profile
             |
             +-----------------------> T5 Durable clear engine -----+
                                                                  |
T3 Durable Lark message deletion -------------------------------> T6 Public clear
                                                                  |
T4 Herdr Core exact session rotation ----------------------------+
                                                                  |
                                                                  v
                                                        T7 Docs and release gate
```

T3 and T4 can proceed independently. T4 is implemented and verified in the
`herdr-core` repository but is tracked here because it is a required part of
the approved end-to-end behavior. Its commit remains separate from this
repository's commits.

## Tickets

### - [x] T1: Lazily bind the group to one managed Orchestrator Thread and Pane

**What to build**

Add the optional project Orchestrator configuration, durable Binding kind, and
Gateway/chat singleton reservation. When enabled for the default project, the
first allowed-user group-root `@Bot` message must recoverably provision one
managed TraeX Binding/Pane/Thread at the configured Orchestrator directory and
submit that message exactly once. Later root mentions return/share the fixed
Thread entry; allowed users converse in that Thread without `@Bot`. Existing
task, alias, and Worker Thread routes remain unchanged.

**Spec references**

SCN-1, SCN-2; INV-1, INV-5; ARCH-1, ARCH-2; Compatibility & Migration.

**Ownership and implementation path**

- Primary Session owns `BindingKind` and singleton lifecycle identity.
- Configuration validates an optional strict `{ enabled, cwd }` block and an
  absolute Orchestrator directory.
- SQLite migration backfills every existing Binding as `task` and enforces one
  non-terminal `orchestrator` per Gateway/chat with an atomic reservation.
- Inbound routing keeps Worker, alias, bound-thread, and explicit command
  precedence, then uses an Orchestrator ensure workflow for the enabled root
  fallback.
- The ensure workflow reuses managed provisioning checkpoints, Agent launch,
  credential injection, lifecycle events, and initial Prompt admission.

**Acceptance criteria and verification**

- Config tests cover missing/disabled/enabled blocks, strict unknown-field
  rejection, invalid relative cwd, normalized `ProjectConfig`, setup summary,
  and existing registry compatibility.
- SQLite tests migrate/reopen legacy rows as task Bindings and prove concurrent
  singleton reservation has one winner and a resolvable loser.
- Routing/provisioning integration tests cover first initialization, duplicate
  Lark event, concurrent roots, crash checkpoint recovery, exact-once initial
  Prompt, no-mention fixed-thread FIFO, later root entry response, unauthorized
  actors, disabled compatibility, and unchanged task/alias/Worker routes.
- Source review confirms route decisions stay in coordinators and SDK/CLI
  representations remain in adapters.
- Run focused config/store/routing/provisioning tests, typecheck, build, and the
  full suite before committing.

**Blocked by:** None.

### - [x] T2: Give the Orchestrator a bounded project-scoped tool profile

**What to build**

Extend Primary tool admission so an exact active Orchestrator turn retains the
existing Worker lifecycle/messaging tools and gains normalized read-only
topology queries for configured Spaces and managed/discoverable Panes. Keep the
profile closed and target resolution server-owned. Do not add arbitrary Pane,
terminal, process, approval, deployment, or Git controls.

**Spec references**

SCN-3; INV-7; ARCH-3; Out of Scope authority restrictions.

**Ownership and implementation path**

- The Primary tool gateway authenticates the Binding kind, generation, parent
  Prompt/turn, capability, and source message.
- The broker uses existing operations-query and Worker application ports; it
  returns normalized projections instead of raw Herdr CLI data.
- MCP definitions are a fixed Orchestrator-aware allowlist. Existing task
  Primary tools remain compatible and do not gain Orchestrator-only topology
  operations accidentally.
- Mutations continue through the existing instance/command workflows and their
  project ownership, generation, session, turn, and idempotency fences.

**Acceptance criteria and verification**

- Broker/gateway/MCP tests cover profile selection, list/inspect results,
  same-project enforcement, stale Binding/Worker/session/turn rejection,
  duplicate idempotency behavior, and task-Primary compatibility.
- Contract tests assert that raw terminal input, key injection, remote approval,
  PID/process kill, Pane kill, retargeting, deployment, push, and unrestricted
  filesystem/process tools are absent.
- Architecture-boundary evidence shows the MCP/CLI representation does not
  enter domain or workflow policy.
- Run focused Primary-tool and operations tests, typecheck, build, and the full
  suite before committing.

**Blocked by:** T1.

### - [x] T3: Deliver idempotent Lark message deletion through the durable outbox

**What to build**

Add a typed message-delete delivery intent whose target is one exact Lark
message ID. Carry it through SQLite, materialization, lane selection, dispatch,
the Lark port/SDK adapter, retry/dead-letter handling, and settlement callbacks.
Normalize deleted and already-absent as successful outcomes while retaining
retryable, permanent, and uncertain failure semantics. This ticket supplies a
generic durable capability; it does not expose `/swarm clear`.

**Spec references**

SCN-6; INV-6; ARCH-6.

**Ownership and implementation path**

- Delivery owns intent typing, idempotency, claim fencing, external-effect
  certainty, retry, and terminal settlement.
- The intent contains only Gateway/provenance identifiers and exact target
  message ID; no card content is needed.
- The Lark adapter translates SDK deletion results/errors into internal
  outcomes. Store and domain modules do not import SDK types.
- Existing outbox rows and intent schema versions remain readable.

**Acceptance criteria and verification**

- Migration/store round trips preserve the new kind and all legacy kinds.
- Materializer and dispatcher tests cover delete success, already absent,
  duplicate delivery, retryable failure, permanent failure, uncertain effect,
  exhausted retry, restart recovery, and lane isolation.
- Lark adapter tests verify the exact message target and normalized error
  classification without logging payloads or credentials.
- Existing card-create/update/stream delivery tests remain green.
- Run focused delivery, outbox, migration, and adapter tests, typecheck, build,
  and the full suite before committing.

**Blocked by:** None.

### - [x] T4: Add exact idempotent same-Pane Agent-session rotation to Herdr Core

**What to build**

In `/workspace/herdr-core`, add a versioned Core CLI/API
operation that, for one stable operation ID, atomically verifies the expected
Pane, terminal, native Agent session, and idle state; terminates only that Agent
session; and launches the supplied managed TraeX configuration in the same Pane.
Return a durable/recoverable receipt identifying the old and new native session.
Preserve Workspace, Pane, Pane token, Pane label/name, tab placement, and PTY.

**Spec references**

SCN-5, SCN-7; INV-2, INV-3, INV-5, INV-6; ARCH-4.

**Ownership and implementation path**

- Herdr Core remains authoritative for Pane/terminal/process/session identity
  and owns atomic fence evaluation plus operation-ID deduplication.
- Define normalized success, already-applied, fence-lost, unsupported launch,
  definitely-not-started failure, and uncertain/recoverable outcomes.
- Persist enough operation identity/receipt state for the same request after a
  caller timeout or Core restart to return the original outcome.
- Do not implement rotation through terminal text, `/new`, raw escape keys,
  arbitrary PID kill, or close/recreate Pane behavior.

**Acceptance criteria and verification**

- Core unit/integration tests cover exact success, every stale fence, non-idle
  refusal, same-operation duplicate before/after restart, concurrent duplicate
  callers, crash boundaries, unsupported launch, and preserved Pane identity.
- A CLI/API contract test produces stable machine-readable responses usable by
  the Swarm adapter and reports capability/version discovery.
- Existing Herdr Pane, PTY, Agent launch, and shutdown tests remain green under
  that repository's instructions.
- Commit only Core-owned files in a separate conventional commit; do not install
  the binary or replace `~/.local/bin/herdr` under this ticket.

**Blocked by:** None.

### - [x] T5: Persist and reconcile a fenced Orchestrator context-clear operation

**What to build**

Add `sessionEpoch` across Binding, Prompt execution, and current projection
ownership, plus the durable `OrchestratorClearOperation` state machine. Add the
consumer-owned `HerdrPort.rotateSession` contract, concrete capability
detection/adapter, quiescence policy, serial dispatcher, atomic receipt/epoch
transition, Main-view reset, startup recovery, and periodic reconciliation.
Exercise this use case directly; do not yet expose the public command or begin
Answer-card withdrawal.

**Spec references**

SCN-4 eligibility, SCN-5, SCN-7; INV-2 through INV-6; ARCH-4, ARCH-5; Domain
Model persistence semantics.

**Ownership and implementation path**

- Primary Session owns epoch validity and stable Binding identity.
- Prompt Execution stamps accepted Prompts with the current epoch and rejects
  stale-epoch dispatch/projection after clear.
- Operations owns operation admission/claim/state, exact fence snapshot,
  idempotency, result, and recovery scheduling.
- The adapter invokes only the T4 versioned Core contract and fails closed when
  unsupported. `src/main.ts` supplies the concrete dependency.
- One SQLite transaction applies the recovered rotation receipt, increments the
  epoch, records audit state, and resets only current Orchestrator Main-view
  pointers. Historical rows and Worker parent generation remain unchanged.

**Acceptance criteria and verification**

- Store migration/round-trip tests preserve Binding kind/epoch, Prompt epoch,
  operation fences/state/receipt, and legacy epoch-1 behavior across reopen.
- Policy/workflow tests reject task Bindings, all nonterminal Prompt and
  detached/recovering/uncertain states, non-idle or composer-not-ready runtime,
  unsupported Core, and stale Pane/terminal/session/generation fences without
  mutation.
- Success tests assert the exact stable identity fields and Workers before and
  after rotation while only native session and epoch change.
- Post-clear tests prove old-epoch prompt/observer/projection activity cannot
  mutate the current Main/Answer view and a new-epoch Prompt uses the new
  session.
- Crash-boundary tests cover before dispatch, possible dispatch, receipt before
  commit, commit before process stop, timeout, and restart reconciliation; every
  retry uses the same operation ID and no Prompt is replayed.
- Run focused store, session reconciliation, prompt concurrency, projection,
  adapter, and recovery tests, typecheck, build, and the full suite before
  committing.

**Blocked by:** T1, T4.

### - [x] T6: Expose confirmed `/swarm clear` and withdraw prior Answer Cards

**What to build**

Deliver the complete public administrator flow. `/swarm clear` in the fixed
Orchestrator Thread creates a single-use confirmation card; the confirmed
action admits T5, snapshots all delivered earlier-epoch Orchestrator Answer
message targets, and enqueues T3 deletion intents after context rotation is
durable. Aggregate settlements into exact deleted/already-absent/failed counts
and publish a succeeded or partial result without rolling back context clear.

**Spec references**

SCN-4, SCN-5, SCN-6, SCN-7; INV-2 through INV-6; ARCH-5, ARCH-6; Behavior &
Failure Modes.

**Ownership and implementation path**

- Command definitions/parser expose one public `clear`; internal request and
  confirm actions retain distinct risk/replay semantics.
- Command authorization requires administrator and exact active Orchestrator
  context. Confirmation identity is unexpired, single-use, actor-bound, and
  generation/Pane/terminal/session/epoch-fenced.
- Clear claim blocks new ordinary Prompt admission until the context phase is
  terminal, then reopens admission on the new epoch even while deletions retry.
- Conversation Projection supplies only delivered prior-epoch Orchestrator
  Answer message IDs. Delivery owns deletion; Operations owns aggregate counts
  and final user result.
- Main, confirmation/result, task, and Worker card IDs are excluded by typed
  provenance, not title or content matching.

**Acceptance criteria and verification**

- Parser/policy/help/docs tests show `/swarm clear` as administrator-only,
  Orchestrator-only, confirmed behavior; aliases and task Threads reject it.
- Confirmation tests cover unauthorized, expired, duplicate, actor mismatch,
  and every identity-fence mismatch with zero rotation/deletion effects.
- End-to-end tests cover zero, one, and multi-page Answer histories; exact
  target selection; no deletion of Main/task/Worker/result cards; preserved
  SQLite history; and new Prompt admission against the cleared context.
- Mixed delivery tests settle accurate deleted/already-absent/failed counts,
  preserve retry/dead-letter evidence, return partial status, and never roll
  back the epoch/session transition or repeat a Prompt.
- Restart tests converge confirmation admission, context-cleared/deletion-
  pending, partially settled, and completed operations exactly once.
- Run focused command, CardKit, clear workflow, projection, outbox, and
  integration tests, typecheck, build, and the full suite before committing.

**Blocked by:** T3, T5.

### - [x] T7: Document compatibility and prepare the gated rollout handoff

**What to build**

Update implementation-backed architecture, Feishu command usage, configuration
examples/setup summaries, and operator guidance for the fixed Orchestrator,
bounded tool authority, `/swarm clear`, partial deletion outcomes, Core version
requirement, and the safe installation/configuration order. Prepare—but do not
execute—the exact live registry change for Orchestrator cwd
`/workspace`.

Deployment-specific handoff: the private target is
`/home/example/.config/herdr-agent-swarm/projects.json`; preserve the
existing `herdr-agent-swarm` project fields and add only the approved
`orchestrator.enabled=true` plus `orchestrator.cwd=/workspace`
after the separate live-change approval.

**Spec references**

All scenarios; ARCH-1 through ARCH-6; Compatibility & Migration; Out of Scope.

**Ownership and implementation path**

- Documentation follows implemented command names, state transitions, config
  schema, version detection, and recovery output rather than anticipated APIs.
- The rollout handoff orders: verify Core capability, build/audit/install
  compatible releases, then edit and validate `projects.json`, inspect restart
  safety, request explicit operational approval, restart, and smoke-test the
  fixed Thread and clear behavior.
- Do not include secrets or the live private registry in Git.

**Acceptance criteria and verification**

- Documentation/config tests and `npm run config:validate` fixtures cover the
  new schema and wording.
- Docs explicitly state that clear retains Pane ID/token/name, Binding/workers,
  and SQLite history; partial Feishu deletion is visible and non-transactional
  with context rotation.
- The handoff names the exact private config target without modifying it and
  preserves a separate confirmation gate for install/restart/live smoke.
- Run documentation audit tests, typecheck, build, and the full suite before
  committing.

**Blocked by:** T2, T6.

### - [x] T8: Preserve Binding identity across the rotation-receipt reconciliation window

**What to build**

Close the delivery-review race where Herdr has already rotated the native Agent
session but SQLite has not yet committed the idempotent receipt. Runtime
reconciliation must preserve the exact Orchestrator Binding while its matching
clear operation is `rotating` or `rotation-uncertain`, allowing receipt recovery
to advance the epoch instead of orphaning the unchanged Pane.

**Spec references**

SCN-5, SCN-7; INV-2, INV-5, INV-6; ARCH-4, ARCH-5.

**Ownership and implementation path**

- SQLite runtime observation atomically matches the active clear operation to
  the Binding's complete old-session fence before suppressing mismatch repair.
- Binding reconciliation treats that explicit pending outcome as owned by the
  durable clear workflow and performs no identity mutation.
- Unrelated session or terminal changes retain the existing fail-closed orphan
  behavior.

**Acceptance criteria and verification**

- An integration test observes the new native session before receipt commit in
  both `rotating` and `rotation-uncertain` states, keeps the Binding attached,
  and then commits the receipt to epoch 2.
- The pre-fix test fails by orphaning the Binding; the repaired focused test,
  full reconciler/clear/store tests, typecheck, and build pass before commit.

**Blocked by:** T5.

## Coverage Review

| Requirement | Responsible tickets |
| --- | --- |
| SCN-1 lazy singleton initialization | T1 |
| SCN-2 fixed-thread routing and compatibility | T1 |
| SCN-3 fenced Orchestrator tools | T2 |
| SCN-4 clear request/confirmation/rejection | T5, T6 |
| SCN-5 stable-identity context rotation | T4, T5, T6, T8 |
| SCN-6 durable withdrawal and partial result | T3, T6 |
| SCN-7 crash/timeout recovery | T3, T4, T5, T6, T8 |
| INV-1 singleton route | T1 |
| INV-2 stable shell identity | T4, T5, T6, T8 |
| INV-3 quiescent clear | T5, T6 |
| INV-4 epoch isolation | T5, T6 |
| INV-5 no replay | T1, T4, T5, T6, T8 |
| INV-6 durable external intent | T3, T4, T5, T6, T8 |
| INV-7 bounded authority | T2 |
| Compatibility, docs, rollout boundary | T1, T2, T7 |

Every ticket traces to approved specification behavior. Blocking edges represent
required contracts or stored capabilities, not merely shared files. The graph
is acyclic. T1, T3, and T4 are initially unblocked; T1 is the recommended first
ticket because it establishes the user-visible Orchestrator identity used by T2
and T5.

## Final Delivery Checks

- Every ticket checkbox is complete and backed by its atomic commit and fresh
  verification evidence.
- Review the cumulative diff against all scenarios, invariants, context owners,
  source-dependency rules, migrations, and security boundaries.
- Run `npm run build`, `npm test`, `npm run typecheck`, documentation audits, and
  repository public audit as applicable to committed scope.
- In `herdr-core`, run that repository's required full verification and retain
  the separate Core commit/version contract evidence.
- Verify neither repository commit includes unrelated pre-existing changes,
  generated runtime state, private config, credentials, or
  `Trae CLI co-author attribution`.
- Stop before install, binary replacement, live `projects.json` mutation,
  service restart, live smoke, push, PR, or external issue publication. Each
  requires its applicable later authorization.
