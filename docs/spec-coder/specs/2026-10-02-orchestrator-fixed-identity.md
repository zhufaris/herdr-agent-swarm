# Orchestrator Fixed Native Identity and Clear Enablement

## Problem Statement

The configured Feishu group already has one durable Orchestrator Binding, but
its Herdr placement and native Pane identity are accidental runtime values. The
current live Orchestrator is bound to Pane `wN:p5M`, terminal
`term_65cdc411e6bd412`, and native Pane token `ri18`. It is not located in the
unique Herdr Space whose exact label is `herdr`, and Core currently has no API
for a caller to request the native token `orch` or atomically reconcile an
existing Pane to that identity.

The public `/swarm clear` path is also unavailable in the installed runtime. It
rejects with `Herdr Core does not support managed same-Pane session rotation`.
The Session Rotation implementation exists only in the unintegrated Core commit
`29150d77`; the installed Herdr 0.9.3 binary does not advertise the command, and
the existing Orchestrator runs TraeX directly rather than under the new Core
supervisor. Consequently, merely installing the current feature branch would
still leave the first rotation of this legacy Pane unserviceable.

The desired result is one stable native identity for the group Orchestrator:
token `orch`, dynamically resolved into the one Space labeled exactly `herdr`,
while preserving the existing Pane/PTY, Binding, Worker ownership, Feishu
Thread, and conversation history. After compatible Core and Swarm releases are
installed, a newly issued `/swarm clear` must rotate only the TraeX session in
that Pane and withdraw the prior Answer Cards through the already designed
durable clear workflow.

## Solution

Add a Core-owned, versioned identity contract and a Swarm-owned durable
convergence workflow:

- Core adds token-aware Pane creation as a new `tab.create.v2` capability. A
  caller may request the valid native Pane token `orch`; Core either allocates
  exactly that session-unique token or rejects without creating a Pane.
- Core adds idempotent `pane.identity_reconcile.v1`. It atomically verifies the
  expected source Pane/terminal identity, target Workspace ID and expected
  Workspace label, and requested token; then it moves the same Pane/PTY into
  the target Workspace and assigns the requested native token. Its receipt is
  durable by operation ID and reports any changed public Pane ID.
- Swarm resolves the target Workspace dynamically from a fresh Herdr snapshot.
  Exactly one Workspace must have the exact label `herdr`; zero or multiple
  matches fail closed. The current observed ID (`w4`) is not configuration and
  must never be hardcoded.
- New Orchestrator provisioning uses `tab.create.v2` with token `orch` in the
  resolved Workspace. It does not fall back to a random token if `orch` is
  occupied.
- Existing Orchestrators use a durable identity-migration operation. Swarm
  persists intent before calling Core, blocks Prompt and clear admission while
  migration is running or uncertain, and applies the Core receipt to the
  Binding in one SQLite transaction after success.
- Core Session Rotation is completed with an exact, idempotent legacy bootstrap
  path. For the first rotation of an idle, directly launched managed TraeX
  process, Core retains the Pane/PTY, durably records the operation, stops only
  the fenced process, and relaunches TraeX under the supervisor. Later rotations
  use the normal supervisor path.
- The previously rejected clear request is historical and is never replayed.
  After deployment and migration, an administrator must issue a new
  `/swarm clear` request.

The fixed identity values in this change are domain policy rather than aliases:

```text
Orchestrator Space label: herdr
Orchestrator native Pane token: orch
```

`orch` is the actual Core `pane.token`. It is not a Pane label, terminal title,
Swarm display token, or derived alias.

## User Stories

### SCN-1: Provision a new Orchestrator with its final identity

When Orchestrator provisioning is required, Swarm obtains a fresh Herdr
snapshot and finds exactly one Workspace whose label is exactly `herdr`. It
asks Core to create the managed TraeX Pane in that Workspace with native token
`orch`. The resulting Binding stores the Core receipt's Workspace ID, Pane ID,
terminal ID, and token.

If no exact `herdr` Workspace exists, more than one exists, `orch` is occupied
by another Pane, the Workspace label changes before Core commits the effect, or
Core lacks the versioned capability, provisioning fails without creating a
fallback Pane or Binding.

### SCN-2: Migrate the current Orchestrator in place

When startup or reconciliation observes the existing Orchestrator Binding with
the wrong Workspace or token, Swarm persists one migration operation containing
an operation ID, Binding generation, expected source Pane/terminal/token, and
the resolved target Workspace ID/label/token. Core moves and retokens the same
Pane/PTY atomically.

The Binding ID, Binding generation, Feishu Thread, Main Card, Workers, project,
creator, and terminal ID remain unchanged. A cross-Workspace move may change
the public Pane ID; Swarm updates it only from the successful Core receipt and
refreshes dependent runtime projections without interpreting an intermediate
snapshot as a replacement Pane.

### SCN-3: Refuse ambiguous or conflicting identity convergence

Migration and provisioning fail closed when Space resolution is missing or
ambiguous. If another Pane owns `orch`, Core returns a stable conflict and
leaves both Panes unchanged. Swarm does not steal the token, close the other
Pane, append a suffix, or accept a random token.

If the current Orchestrator already owns `orch` in the uniquely resolved
`herdr` Workspace, reconciliation is a no-op success. Repeating the same
operation ID after a timeout or process restart returns the original receipt;
it does not perform a second move or token mutation.

### SCN-4: Fence work during identity migration

From durable migration admission until receipt application or an authoritative
rejection, ordinary Prompt admission and `/swarm clear` admission for the
Binding are blocked with an actionable migration status. Existing queued work
is retained but not dispatched. Worker Bindings and their sessions remain
unchanged.

If Swarm crashes before the Core call, it can retry the persisted operation. If
it crashes after Core may have applied the change, it repeats the same operation
ID and converges from the receipt. An unknown external effect remains visibly
uncertain; Swarm must not guess the new Pane ID or issue an unkeyed second move.

### SCN-5: Bootstrap the legacy Pane into managed session rotation

After identity convergence, a newly confirmed `/swarm clear` applies the
existing Binding, Prompt, Pane, terminal, native-session, idle, and
composer-ready fences. If the exact Pane is still running the legacy direct
TraeX process rather than the supervisor, Core records the rotation operation
before process mutation, verifies that the exact fenced process is the managed
TraeX launch and is idle, stops only that process, and starts the requested
TraeX launch under the supervisor in the same Pane/PTY.

Core returns a receipt containing the old and new native session identities.
Swarm then completes the previously specified epoch transition and Answer Card
withdrawal. The Pane token remains `orch`, and the Pane/PTY, Binding, Workers,
and Feishu Thread remain stable.

### SCN-6: Recover or reject legacy bootstrap safely

Repeating the same rotation operation after a timeout recovers the supervisor
journal and returns the same result. A crash after the old process stops but
before the new launch becomes observable is recovered from durable Core intent;
Swarm never submits a Prompt as part of recovery.

Core rejects without killing anything when the Pane, terminal, native session,
agent kind, command identity, or idle fence differs; when another foreground
process owns the PTY; or when the platform cannot provide the required exact
process fencing. The operation remains actionable rather than silently falling
back to key injection, `/new`, Pane replacement, or an untracked restart.

### SCN-7: Preserve compatibility and operational control

Existing `tab.create` clients keep their automatic-token behavior. Existing
Pane move and rename commands keep their semantics. The new capabilities are
advertised separately so older Core binaries cannot ignore a load-bearing token
or identity fence and incorrectly report success.

Implementation, build, installation, service restart, live identity migration,
and the new clear request are separate stages. Code approval does not authorize
deployment, live SQLite mutation, or replay of the rejected clear request.

## Implementation Decisions

### Domain Model

This work crosses two authoritative systems and three relevant contexts:

| Context | Model and responsibility |
| --- | --- |
| Core Pane Identity | Core owns `PaneToken`, Workspace membership, public Pane ID, terminal identity, and the session-wide token uniqueness constraint. It alone may atomically create or reconcile native identity. |
| Swarm Primary Session | The Orchestrator `Binding` owns the durable association to Feishu and the desired managed identity. An `OrchestratorIdentityMigration` records convergence intent and receipt application without replacing the Binding aggregate. |
| Core Agent Session | The Session Rotation operation owns exact process/session fencing, supervisor journal recovery, and the old-to-new native session receipt. Swarm owns clear admission and downstream Binding epoch/card effects. |

The user-facing term **Space** maps at the Core boundary to a Herdr Workspace.
Space selection uses exact label equality; the label is a lookup constraint,
while the resolved Workspace ID is the identity used for one operation. Core
rechecks both so a label rename between snapshot and mutation cannot target the
wrong Space.

The native token `orch` is a valid four-character lowercase base36
`PaneToken`. Equality is exact and session-wide. It must not be normalized,
truncated, suffixed, or substituted. Token availability and mutation are Core
invariants, not Swarm prechecks.

The significant invariants are:

- **INV-1 — Unique exact Space:** an Orchestrator identity operation requires
  exactly one fresh Workspace whose label equals `herdr`.
- **INV-2 — Exact native token:** a converged Orchestrator owns Core
  `pane.token == "orch"`; conflict is terminal for that attempt and cannot
  degrade to automatic allocation.
- **INV-3 — Same Pane/PTY:** migration and legacy rotation preserve terminal
  identity and the running Pane object. A changed public Pane ID is allowed
  only as the receipt-defined consequence of cross-Workspace migration.
- **INV-4 — Binding continuity:** identity migration preserves Binding ID,
  generation, Feishu Thread/cards, project, creator, Workers, and Prompt
  history.
- **INV-5 — Durable before external effect:** Swarm persists migration intent
  before Core mutation; Core persists rotation/reconcile intent before any
  irreversible process or identity mutation.
- **INV-6 — Idempotent recovery:** one operation ID has one immutable request
  identity and one terminal receipt. A mismatched reuse is rejected.
- **INV-7 — Quiescent migration:** no Prompt dispatch or clear may race an
  active or uncertain identity migration.
- **INV-8 — No prompt replay:** identity and session recovery never replay a
  rejected, submitted, or possibly submitted Prompt.

No new business entity is needed for Space or Pane. They remain normalized
external runtime observations. The durable migration operation is justified by
cross-process uncertainty and receipt application, not by the UI label.

### Architecture

**ARCH-1 — Versioned Core creation.** Core introduces `tab.create.v2` rather
than adding a load-bearing field to the published `tab.create` method. Its
request includes the current create parameters plus optional requested native
token and, for this managed path, expected Workspace label. Its success receipt
returns the created Workspace/Tab/Pane/terminal/token identity. Invalid token,
occupied token, missing Workspace, label mismatch, and creation failure have
stable error codes and create no partial Pane. The original `tab.create`
continues to allocate a random unique token.

**ARCH-2 — Atomic Core identity reconciliation.** Core introduces
`pane.identity_reconcile.v1` with a request shaped around an internal consumer:

```text
operation_id
expected: pane_id, terminal_id, current_workspace_id, current_token
target: workspace_id, expected_workspace_label, token
```

The handler validates the immutable operation request, exact current identity,
target label, and token ownership before mutation. It moves the existing Pane
through Core state APIs, assigns the token through the authoritative allocator,
repairs any public Pane-ID aliases using existing move semantics, persists the
result, and returns old/new identity plus a no-op/applied disposition. Failure
is atomic from the caller's perspective. Durable receipt lookup/replay uses the
operation ID; the caller never reconstructs a receipt from a later snapshot.

**ARCH-3 — Swarm capability and adapter boundary.** The Herdr port gains
versioned creation and identity-reconcile request/receipt types. CLI parsing and
JSON normalization remain in `src/adapters/herdr-adapter.ts`; coordinators see
only normalized domain results. Capability detection must distinguish
`tab.create.v2`, `pane.identity_reconcile.v1`, and
`agent.session_rotate.v1`. Missing support yields an actionable unavailable
state rather than invocation of an older ambiguous method.

**ARCH-4 — Dynamic Space directory.** Swarm resolves `herdr` from the existing
fresh Workspace snapshot/directory seam. It does not derive the target from the
project registry's current `workspaceId`, cache `w4` as configuration, or use a
partial/case-insensitive match. Core performs the final expected-label check.

**ARCH-5 — Durable Swarm migration.** SQLite adds a migration record keyed by
Binding and immutable operation ID. It stores the expected source identity,
target identity, Binding generation, state, Core receipt/error, and timestamps.
Admission, claim, uncertain recovery, rejection, and receipt application are
transactional under the existing instance lease/fence. Applying a receipt
updates all Binding-owned Pane identity fields and necessary lookup projections
atomically; Workers remain parented to the same Binding generation.

Startup and periodic reconciliation use one coordinator path. If the Binding
is already converged, they record/recognize success without mutation. If an
operation is accepted or uncertain, they repeat only the same Core operation
ID. Prompt and clear admission consult the durable migration state rather than
card text or a transient in-memory flag.

**ARCH-6 — New provisioning path.** Orchestrator provisioning resolves the
Space first and calls the versioned create capability with `orch`. Other
managed task/Worker provisioning keeps the existing automatic-token path.
Provisioning recovery records and reuses the Core creation receipt under its
existing checkpoints; it never retries with a different token after conflict.

**ARCH-7 — Legacy supervisor bootstrap.** The existing
`agent.session_rotate.v1` contract is extended without weakening its exact
fences. When no supervisor socket exists, Core may bootstrap only an observed,
idle, directly launched managed TraeX process whose Pane, terminal, native
session, process identity, and launch specification match the request. The Core
operation journal is durable before stopping the process. Recovery determines
whether to finish the same launch, return the recorded receipt, or retain an
uncertain/failed result; it never performs a second unfenced stop.

Normal supervised rotation remains unchanged. Unsupported platforms or agent
kinds fail explicitly while the code continues to compile under the repository
Linux and Windows targets. The Swarm adapter does not implement a process-level
fallback.

**ARCH-8 — Composition and dependency direction.** Core schema/CLI adapters
translate versioned requests into application operations; Pane state and the
session supervisor enforce identity/process invariants. Swarm inbound and
reconciliation workflows depend on domain ports; the Herdr CLI adapter supplies
those ports; `src/main.ts` assembles them. SQLite does not invoke Core, and Core
does not know about Feishu Bindings or cards.

### Behavior & Failure Modes

Identity convergence uses the following durable progression:

```text
required -> accepted -> applying -> applied
                       |          |
                       |          +-> receipt applied to Binding
                       +-> uncertain -> same operation recovery
                       +-> rejected / failed
```

Only `applied` permits new Prompt or clear admission. A target collision,
missing/duplicate Space, stale source fence, renamed target Space, or unsupported
Core capability leaves the Binding unchanged and produces an operator-visible
failure. An external timeout after invocation produces `uncertain`, not a new
operation.

Core reconciliation commits identity as one logical operation. If its internal
persistence cannot make the move/token/receipt atomic, it must journal a
recoverable intent before the first state mutation and hide intermediate state
from competing identity operations. Recovery either completes that exact
operation or returns its terminal failure; it never allocates another token.

During cross-Workspace migration, callers must use the receipt's new Pane ID.
Swarm updates the Binding and its Pane lookup aliases in the same transaction
that records receipt application. A stale event carrying the old Pane ID cannot
replace the terminal identity or detach the Binding.

The legacy rotation bootstrap is only reached after all existing clear fences
pass. Failure before the exact process is stopped is a rejection with no effect.
Failure after a possible stop is recovered by Core operation ID and remains
uncertain to Swarm until Core supplies an authoritative receipt. A successful
rotation changes native session identity and Swarm `sessionEpoch` only; it does
not change token `orch` or any topology identity.

### Compatibility & Migration

- `tab.create` and all non-Orchestrator provisioning preserve automatic token
  allocation and existing response semantics.
- New versioned Core methods are additive. Older Core binaries advertise no
  capability, and Swarm refuses provisioning/migration/clear paths that require
  them.
- Existing persisted Pane tokens remain valid. Core restore continues to repair
  only missing, invalid, or duplicate tokens under its existing rules.
- Existing Orchestrator Binding data is not recreated. A new additive SQLite
  migration initializes identity-migration storage without fabricating a
  completed receipt.
- The current live Binding `50f8deea-879a-4c59-9ee2-b29d1c4591f7`
  is migrated only during the separately authorized live operation. Its current
  Pane ID may change from `wN:p5M`; terminal `term_65cdc411e6bd412`, Binding,
  Workers, and Feishu Thread must remain stable.
- The previously rejected `/swarm clear` request and previously repaired seven
  historical prompt rows are not replayed or rewritten by this feature.

## Testing Decisions

### Core

- `tab.create.v2` tests cover valid requested token, invalid token, occupied
  token, exact label mismatch, rollback/no partial creation, and unchanged v1
  automatic allocation.
- Pane identity tests use adversarial Core state and invariants. They verify
  same-Workspace retoken, cross-Workspace move with public Pane-ID change,
  terminal/process preservation, exact collision refusal, target rename race,
  already-converged no-op, mismatched operation-ID reuse, and receipt replay
  after reopen.
- Session Rotation tests cover normal supervised rotation and the legacy direct
  TraeX bootstrap. They prove durable intent precedes stop, only the exact idle
  process is stopped, the PTY and token survive, a new native session is
  returned, stale fences reject without effect, and recovery does not issue a
  second stop or launch.
- Schema/CLI tests freeze the new method names, request fields, receipts, error
  codes, and advertised capabilities without altering published v1 fixtures.
- `just check` must pass with Linux tests and Windows cross-Clippy. Platform
  gating must not leave unused imports, constants, or enum variants under
  `x86_64-pc-windows-msvc`.

### Swarm

- Adapter tests verify exact versioned command arguments, JSON normalization,
  stable error mapping, capability detection, and redaction.
- Provisioning tests verify exact `herdr` resolution, zero/duplicate rejection,
  requested `orch`, collision refusal, receipt persistence, and no random-token
  fallback while leaving task/Worker provisioning unchanged.
- SQLite tests cover migration schema upgrade, immutable operation identity,
  transactional claims, uncertain reopen, idempotent receipt application,
  changed Pane-ID indexes, and unchanged Binding generation/Worker ownership.
- Coordinator integration tests cover admission blocking, successful in-place
  migration, stale source fences, target rename, collision, crash before/after
  Core effect, repeated receipt, stale old-Pane events, and convergence after
  restart.
- Clear integration tests cover the first legacy bootstrap and later supervised
  rotation through the same port, plus exact proof that a historical rejected
  clear is not replayed.
- Full verification is `npm run build`, `npm run typecheck`, and `npm test` for
  Swarm, plus Core `just check` in a clean non-Herdr-agent environment with the
  supported Zig/Windows toolchain.

Live validation, after a separate deployment approval, must observe exactly one
Space labeled `herdr`, confirm `orch` is unoccupied or owned by the migrating
Pane, verify zero active/nonterminal Prompt blockers, install compatible Core
and Swarm builds, reconcile the Binding, and compare the pre/post Pane,
terminal, Binding, Worker, Thread, and token identities. Only then may an
administrator issue a new `/swarm clear` and verify Answer Card withdrawal.

## Out of Scope

- Replaying the rejected clear request or any historical Prompt.
- Renaming, deleting, or merging Herdr Spaces to manufacture an exact match.
- Stealing `orch` from another Pane or choosing a fallback token.
- Recreating the Orchestrator Pane, Binding, Workers, or Feishu Thread.
- Exposing arbitrary terminal input, raw process control, approval/denial, Pane
  kill, or unrestricted topology mutation through Swarm.
- Changing token rules for ordinary task Primaries or Workers.
- Automatically installing, restarting, migrating live state, or sending a new
  clear request as part of code implementation.
- Fixing the pre-existing OpenCode V2 100ms test flake except as separately
  scoped maintenance work.

## Further Notes

The approved design is implemented in two isolated workspaces:

- Swarm: `/tmp/herdr-agent-swarm-orchestrator-fixed-identity`, branch
  `feat/orchestrator-fixed-identity`, starting revision
  `87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7`. The original checkout's modified
  `TODO.md` and all unrelated worktrees are preserved. A native worktree at
  `.trae/worktrees/orchestrator-fixed-identity` exists but is read-only in this
  environment and is not used or removed.
- Core implementation: `/tmp/herdr-core-journal-v2-recovery-rotation`, branch
  `fix/journal-v2-recovery-session-rotation`, current revision
  `068e3fc7860c22b211445ca621e283df9f12c939`. Its initial task-owned commits
  include Session Rotation `29150d77` and journal recovery changes. The green
  pre-change baseline is `e848f0fe`; those later commits are initial
  implementation to review and repair, not baseline product state.

Fresh Swarm baseline evidence:

```text
npm run build        PASS
npm run typecheck    PASS
npm test             251 files, 3593 tests passed
```

Fresh Core pre-change baseline evidence was obtained by executing every
`just check` constituent against `e848f0fe`: 3937 Rust tests passed with 14
skipped; 150 maintenance tests, 6 UI architecture tests, all integration asset
tests, Windows MSVC cross-Clippy, and 7 documentation contract tests passed.
The host required Zig 0.16.0, an authorized `xwin`/Microsoft SDK installation,
a temporary Git 2.39 compatibility shim for `--default-prefix`, and removal of
the inherited `HERDR_AGENT=codex` variable from Core test processes.

One pre-existing OpenCode V2 test is timing-flaky at the 100ms reconciliation
boundary: 20 isolated repetitions produced 12 passes and 8 failures, and the
same failure reproduces at the pre-change baseline. It is recorded but excluded
from this feature's behavior. The complete constituent suite has fresh green
evidence without weakening or deleting that test.

T0-T3 have since completed on the Core branch. Native and Windows lint, the
full Core test suite, maintenance checks, integration assets, and documentation
contracts passed before the T3 commit.

Gates 1-3 are approved. Gate 3 authorizes implementation and the listed atomic
commits only; installation, service restart, live migration, a new clear
request, push, PR, and external publication remain unauthorized.
