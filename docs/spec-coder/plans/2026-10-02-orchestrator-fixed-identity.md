# Orchestrator Fixed Native Identity and Clear Enablement Plan

Specification:
[`docs/spec-coder/specs/2026-10-02-orchestrator-fixed-identity.md`](../specs/2026-10-02-orchestrator-fixed-identity.md)

Gate 1 design, Gate 2 specification, and Gate 3 implementation authorization
are approved.

## Workspaces and Initial State

- Swarm implementation workspace:
  `/tmp/herdr-agent-swarm-orchestrator-fixed-identity`, branch
  `feat/orchestrator-fixed-identity`, starting revision
  `87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7`.
- Core implementation workspace:
  `/tmp/herdr-core-journal-v2-recovery-rotation`, branch
  `fix/journal-v2-recovery-session-rotation`, current revision
  `068e3fc7860c22b211445ca621e283df9f12c939`.
- Core green pre-change baseline: `e848f0fe`. The existing Core commits
  `29150d77` (same-Pane rotation), `00978f7b` (journal-v2 recovery), and
  `4598e543` (stream-only journal migration) are task-relevant initial changes
  to preserve, review, and repair rather than amend.
- The user's modified `TODO.md`, dirty Core main checkout, read-only native
  Swarm worktree, and all unrelated worktrees are excluded from task commits.

Fresh baseline evidence:

```text
Swarm npm run build       PASS
Swarm npm run typecheck   PASS
Swarm npm test            251 files, 3593 tests passed

Core pre-change native    3937 tests passed, 14 skipped
Core maintenance          150 tests passed
Core UI architecture      6 tests passed
Core integration assets   PASS
Core Windows MSVC clippy  PASS
Core docs contract        7 tests passed
```

Core checks on this host require Zig 0.16.0, the configured Windows SDK,
`HERDR_AGENT` removed from child test environments, and a temporary Git 2.39
compatibility shim for `git diff --default-prefix`. The pre-existing OpenCode
V2 late-hydration test is timing-flaky at 100ms and is tracked as baseline
noise; it is not weakened or removed by this plan.

## Dependency Map

```text
T0 Core branch baseline ----> T1 Core exact creation -----> T2 Core reconcile --+
          |                                                                   |
          +------------------> T3 Core legacy rotation -----------------------+
                                                                              |
                         +----------------------------------------------------+
                         |
                         +--> T4 contracts
                                  |
                                  +--> T5 fixed provisioning
                                  +--> T6 durable in-place migration
                                               |
                                               +--> T7 clear convergence
                                                            |
                                                            +--> T8 delivery/docs
```

T0 restores a green cross-platform starting point for the existing Core task
branch. T1 and T3 can then be implemented independently. T4 freezes Swarm's
consumer-side contracts after the Core receipts are concrete. T5 and T6 are
separate user capabilities; T7 requires both an applied identity migration and
the legacy rotation support needed by the current live Pane.

## Tickets

### - [x] T0: Restore the existing Core task branch's cross-platform baseline

**What to build:** Make the already committed Session Rotation and journal-v2
initial changes warning-free under the repository's Windows cross-Clippy target
without changing their Linux behavior or suppressing warnings.

**Spec references:** SCN-7; ARCH-7, ARCH-8; Further Notes baseline evidence.

**Ownership and implementation path:** Apply precise platform gating or move
platform-neutral definitions so `Instant`, `CHILD_STOP_TIMEOUT`,
`UnsupportedRotatableKind`, and the journal-added render profiling helper exist
only where used. Do not amend the three existing commits or mix new identity
behavior into this repair.

**Acceptance criteria and verification:**

- The four observed Windows dead-code/unused errors disappear without an
  `allow`/`expect` suppression.
- Native Session Rotation and journal tests remain unchanged and green.
- `just windows-lint`, native formatting/Clippy, and affected tests pass.

**Blocked by:** None.

**Proposed commit:** `fix(build): keep feature-gated helpers warning-free`

### - [x] T1: Create a Core Pane with an exact native token

**What to build:** Add the versioned `tab.create.v2` Core API/CLI capability so
managed callers can request `orch` at Pane creation without changing legacy
`tab.create` behavior.

**Spec references:** SCN-1, SCN-3, SCN-7; INV-1, INV-2, INV-5, INV-6;
ARCH-1, ARCH-8.

**Ownership and implementation path:** Core Pane Identity owns validation,
session-wide uniqueness, allocation, and the returned Pane/terminal/token
identity. Extend schema and advertised method surfaces additively, route through
the existing application creation path, and reserve the requested token in the
same mutation that creates the Pane. The target Workspace ID and expected label
are revalidated at the Core boundary.

**Acceptance criteria and verification:**

- Valid `orch` creation returns exactly `orch` and the authoritative identities.
- Invalid or occupied tokens, missing Workspace, and renamed-label races return
  stable errors and create no Pane.
- Concurrent requests cannot both own `orch`.
- Existing `tab.create` still auto-allocates a unique token.
- New schema/CLI capability tests pass; Core formatting, native tests, and
  Windows cross-Clippy pass.

**Blocked by:** T0.

**Proposed commit:** `feat(panes): add exact token-aware creation`

### - [x] T2: Reconcile Core Pane identity atomically and idempotently

**What to build:** Add `pane.identity_reconcile.v1` so one exact existing Pane
can move into the resolved Workspace and acquire `orch` without replacing its
PTY or process.

**Spec references:** SCN-2, SCN-3, SCN-4; INV-1 through INV-7; ARCH-2, ARCH-8.

**Ownership and implementation path:** Core Pane Identity owns the operation
request, source/target fences, token mutation, Workspace move, public Pane-ID
alias changes, durable receipt, and recovery. Reuse the existing Pane move and
state persistence machinery, adding only the operation journal/receipt state
needed to make retry safe. Core revalidates the exact target label and rejects
mismatched reuse of an operation ID.

**Acceptance criteria and verification:**

- Same-Workspace retoken and cross-Workspace migration both preserve terminal
  and foreground process identity.
- Cross-Workspace success returns the authoritative new Pane ID and maintains
  Core identity invariants under adversarial state.
- Collision, stale source, target rename, and invalid token fail without
  partial mutation.
- Already-converged and repeated-operation calls return deterministic receipts.
- Reopen/recovery tests prove no second move or token allocation.
- API fixtures remain additive and Core native/Windows checks pass.

**Blocked by:** T1.

**Proposed commit:** `feat(panes): add idempotent identity reconciliation`

### - [x] T3: Bootstrap legacy Panes into same-Pane Session Rotation

**What to build:** Complete the existing Session Rotation implementation so the
first clear of an exact idle, directly launched TraeX process can install the
supervisor in the same Pane/PTY and later calls use normal supervised rotation.

**Spec references:** SCN-5, SCN-6, SCN-7; INV-3, INV-5, INV-6, INV-8;
ARCH-7, ARCH-8.

**Ownership and implementation path:** Core Agent Session owns the supervisor
journal, exact process/session fences, stop and relaunch sequence, immutable
operation identity, and receipt recovery. Preserve the current
`agent.session_rotate.v1` request shape and existing normal supervisor path.
Add the narrowly fenced legacy path and correct all platform-conditional code
so unsupported platforms reject explicitly while Windows still compiles.

**Acceptance criteria and verification:**

- A direct idle managed TraeX process rotates under the supervisor without
  changing Pane, PTY, Workspace, or token.
- Stale Pane/terminal/session/state/process/launch fences stop before mutation.
- Crash-point and duplicate-operation tests prove at-most-one stop/launch and
  stable receipt recovery.
- Existing supervised rotation behavior remains green.
- The current branch's Windows unused import/constant/variant errors are fixed
  without warning suppression; unrelated initial journal behavior remains
  intact.
- Full affected Core tests and Windows cross-Clippy pass.

**Blocked by:** T0.

**Proposed commit:** `fix(agents): bootstrap legacy same-pane rotation`

### - [x] T4: Freeze Swarm's versioned Core identity contracts

**What to build:** Extend the Swarm Herdr port and adapter with normalized
versioned create, identity-reconcile, and rotation capability contracts.

**Spec references:** SCN-1, SCN-3, SCN-6, SCN-7; INV-2, INV-6;
ARCH-3, ARCH-8.

**Ownership and implementation path:** Domain ports own consumer-shaped
requests, receipts, and stable error categories. The Herdr adapter owns CLI
arguments, JSON parsing, method capability probing, timeout classification, and
redacted failures. No coordinator parses raw Core JSON or guesses a receipt
from a snapshot.

**Acceptance criteria and verification:**

- Adapter tests freeze exact method names/arguments and all receipt fields.
- Missing capability, collision, stale fence, label mismatch, rejection,
  timeout/uncertain, and malformed JSON normalize distinctly.
- Prompt/launch arguments remain redacted from errors.
- Existing non-versioned creation and rotation consumers remain compatible.
- Focused adapter tests, architecture boundaries, typecheck, and build pass.

**Blocked by:** T1, T2, T3.

**Proposed commit:** `feat(orchestrator): add fixed identity core contracts`

### - [x] T5: Provision new Orchestrators directly in `herdr` as `orch`

**What to build:** Change only Orchestrator provisioning to resolve the exact
Space and request the final native token at creation.

**Spec references:** SCN-1, SCN-3, SCN-7; INV-1, INV-2, INV-4, INV-5;
ARCH-4, ARCH-6.

**Ownership and implementation path:** The Orchestrator provisioning workflow
uses the fresh Workspace directory seam, requires one exact `herdr` label, and
passes `orch` through the versioned port. Existing provisioning checkpoints
store and reuse the Core receipt. Ordinary Primary and Worker lifecycle paths
retain automatic token allocation and project Workspace routing.

**Acceptance criteria and verification:**

- Zero or duplicate exact Space matches fail before Pane creation.
- A label rename or occupied `orch` fails without fallback or partial Binding.
- Duplicate/recovered provisioning converges on one Pane and one Binding.
- The persisted Binding contains the receipt identities.
- Task Primary and Worker provisioning regression tests remain green.

**Blocked by:** T4.

**Proposed commit:** `feat(orchestrator): provision with fixed pane identity`

### - [x] T6: Migrate an existing Orchestrator Pane in place

**What to build:** Add the durable Swarm identity-migration operation,
reconciliation runner, receipt application, and admission fence for an existing
Orchestrator.

**Spec references:** SCN-2, SCN-3, SCN-4; INV-1 through INV-8; ARCH-4, ARCH-5,
ARCH-8.

**Ownership and implementation path:** SQLite owns immutable operation intent,
claim/lease state, uncertain recovery, receipt/error, and transactional Binding
identity application. One coordinator path serves startup and periodic
reconciliation. Prompt and clear admission consult the durable migration state.
Core remains authoritative for the move/token effect and any new public Pane
ID; Worker ownership remains on the unchanged Binding generation.

**Acceptance criteria and verification:**

- Schema migration is additive and idempotent on legacy databases.
- Intent is durable before Core invocation; duplicate claims have one winner.
- Success preserves Binding/terminal/Thread/Workers and updates a changed Pane
  ID plus lookup projections atomically.
- Prompt and clear admission block during accepted/applying/uncertain states,
  retaining FIFO work without dispatch.
- Crash before invocation, timeout after possible effect, restart receipt
  recovery, stale old-Pane events, rejection, and already-converged behavior are
  covered at SQLite/coordinator integration seams.

**Blocked by:** T2, T4.

**Proposed commit:** `feat(orchestrator): reconcile fixed pane identity`

### - [x] T7: Complete `/swarm clear` through the converged native identity

**What to build:** Connect clear capability/admission/recovery to the converged
identity and Core's legacy bootstrap receipt so the current Orchestrator can
successfully clear on a newly issued request.

**Spec references:** SCN-4 through SCN-7; INV-3, INV-5 through INV-8; ARCH-3,
ARCH-5, ARCH-7.

**Ownership and implementation path:** The existing clear workflow remains the
owner of administrator confirmation, quiescence, epoch transition, Answer Card
withdrawal, and no-replay policy. It adds migration-state admission and consumes
the exact Core rotation receipt through the normalized port. Core owns whether
legacy bootstrap or normal rotation is required; Swarm never kills or relaunches
the process itself.

**Acceptance criteria and verification:**

- Clear refuses while identity migration is incomplete or uncertain.
- After convergence, first legacy bootstrap and later supervised rotation both
  produce the existing successful epoch/card transition.
- Exact stale fences and uncertain Core effects retain existing rejection and
  recovery semantics.
- The rejected historical clear request is never selected or replayed.
- Clear workflow, SQLite recovery, session operation, and concurrency tests
  pass with no Prompt replay.

**Blocked by:** T3, T6.

**Proposed commit:** `fix(orchestrator): enable clear after identity convergence`

### - [x] T8: Document and verify the fixed identity lifecycle

**What to build:** Update implementation-backed architecture/operator docs and
run final cross-repository verification without performing live deployment.

**Spec references:** SCN-1 through SCN-7; all invariants; ARCH-1 through ARCH-8;
Compatibility & Migration; Testing Decisions.

**Ownership and implementation path:** Swarm docs explain the exact Space/token
policy, migration states, admission behavior, and post-install operator checks.
Core unreleased docs describe the versioned methods, receipts, capability
advertisement, and legacy bootstrap limits without editing stable/preview
generated documentation. The local spec and plan remain the traceability source.

**Acceptance criteria and verification:**

- Docs match final method names, fields, error modes, and runtime behavior.
- Swarm passes focused tests, `npm run typecheck`, `npm run build`, and
  `npm test`.
- Core passes focused tests and `just check` under the recorded clean test
  environment and Windows toolchain.
- Diff review confirms no credentials, runtime databases/logs, generated
  `dist/`, unrelated user changes, or live identifiers beyond documented
  non-secret migration references are committed.
- No install, restart, live migration, clear request, push, or PR occurs.

**Blocked by:** T5, T6, T7.

**Proposed commit:** `docs(orchestrator): document fixed native identity`

### - [x] T9: Let terminal uncertain Prompts release identity migration

**What to build:** Repair the live-discovered lifecycle mismatch where a Prompt
that has already terminalized as `uncertain/completed` is still classified as
active by the Orchestrator identity migration store and blocks convergence
forever.

**Spec references:** SCN-2, SCN-3; INV-1, INV-4; ARCH-4, ARCH-5.

**Ownership and implementation path:** Prompt execution state remains
authoritative. The migration store must distinguish an unresolved uncertain
Prompt from the existing terminal `uncertain/completed` outcome without
rewriting historical Prompt state or replaying input.

**Acceptance criteria and verification:**

- `uncertain/completed` does not block identity migration.
- `uncertain/detached` continues to block identity migration.
- Core receipts are matched by field values, independent of JSON property order.
- No historical Prompt row is rewritten and no Prompt is replayed.
- Focused migration tests, typecheck, build, and the full suite pass.

**Blocked by:** T6.

**Commits:** `fix(orchestrator): release migration after terminal prompt` and
`fix(orchestrator): match Core receipt by identity`

## Coverage and Commit Policy

Every scenario and invariant is assigned to at least one behavior ticket and
one final verification pass. T0-T3 are Core commits; T4-T8 are Swarm commits.
Tickets are committed only after their focused and affected checks pass. Core
commits are additive on top of the existing task branch; prior commits are not
amended. The exact proposed commit subjects above satisfy the Core repository's
pre-commit alignment requirement if Gate 3 is approved.

Gate 3 authorizes implementation, focused edits, tests, and the listed atomic
commits. It does not authorize installation, systemd restart, mutation of the
live Orchestrator or database, sending a new `/swarm clear`, pushing either
branch, opening a PR, or publishing artifacts. Those remain a separate explicit
operational gate after verified delivery.
