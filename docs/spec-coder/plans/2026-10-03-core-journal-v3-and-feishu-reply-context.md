# Core Journal v3 Recovery and Feishu Reply Context Plan

Specification: [2026-10-03-core-journal-v3-and-feishu-reply-context.md](../specs/2026-10-03-core-journal-v3-and-feishu-reply-context.md)

Approval status: specification and ticket set approved; implementation authorized.

## Workspace and baseline

- Swarm: `/tmp/herdr-agent-swarm-orchestrator-fixed-identity`, branch
  `feat/orchestrator-fixed-identity`, start
  `4bcb95c6a7fa1891fa5437c94668e666a148dd47`, initially clean.
- Core: `/tmp/herdr-core-journal-v2-recovery-rotation`, branch
  `fix/journal-v2-recovery-session-rotation`, start
  `ea1d35dfe436bc28de90eddbf0d4286b174c4ea6`, initially clean.
- Swarm baseline: 252 files / 3,642 tests, typecheck, and build passed.
- Core accepted narrow baseline: format and Clippy passed; journal tests 19/19
  passed. The user authorized proceeding despite eight separately recorded,
  reproducible pre-existing CLI/PTY failures in the full suite.

## Tickets

### - [x] T1: Open deployed journal v3 without weakening no-replay recovery

**What to build:** Upgrade the Core journal to version 4 and transactionally
convert the known deployed v3 receipt schema into the branch's richer recovery
schema. Preserve all available identity/evidence, conservatively terminalize
ambiguous historical receipts, reject unknown shapes, and keep migration reopen
idempotent.

**Spec references:** SCN-1, SCN-2; Domain Model; Architecture; Behavior & Failure
Modes; Compatibility & Migration.

**Ownership and implementation path:** Core's Agent Event Journal remains the
sole schema and receipt owner. Extend `src/agent_events/journal.rs` at the
existing locked open/migration boundary. The migration is one SQLite
transaction and creates no transcript or turn identity absent from v3. No API,
session-rotation, Pane identity, or Swarm code changes belong to this ticket.

**Acceptance criteria and verification:**

- A fixture with the deployed v3 `correlated` columns opens successfully and
  ends at `user_version=4` with the richer columns and indexes.
- Every v3 state has an explicit conservative mapping; a migrated receipt cannot
  become a fresh submission merely because exact turn evidence was unavailable.
- Reopening the migrated database is a no-op and retains receipt results.
- Existing v1, stream-v2, rich-v2, turn-index, and recovery tests remain green.
- Run the new failing test before implementation, then affected journal tests,
  format, Clippy, release build, and a final full-suite retry.
- Commit as `fix(agent-events): migrate deployed journal v3` with no AI
  co-author trailer.

**Blocked by:** None.

### - [x] T2: Keep Feishu batch envelopes out of Reply Context

**What to build:** Add an optional explicit Reply Context to Run Projections,
populate it from original Feishu batch members, and make Answer headers prefer
it. For old projections, unwrap only a complete canonical envelope at render
time. Preserve exact Prompt, batch, request-text, and Core submission bytes.

**Spec references:** SCN-3, SCN-4, SCN-5; Domain Model; Architecture; Behavior &
Failure Modes; Compatibility & Migration.

**Ownership and implementation path:** Native Input Batching owns canonical
envelope parsing and ordered member meaning. Binding Prompt admission supplies
the display-only value. Run Projection stores it as an optional compatibility
field. Answer header projection performs redaction, single-line normalization,
and bounding and owns the historical fallback. SQLite persistence adds a
nullable Run Card column and exposes it through the existing JSON projection
without a destructive schema migration.

**Acceptance criteria and verification:**

- Single-message Answer subtitle contains only the user's text.
- Multi-message Reply Context retains source order and contains no bridge-owned
  envelope lines.
- A user's literal `[Feishu message 1/1]` remains visible when nested inside the
  bridge-owned outer envelope.
- Partial, malformed, or non-batch lookalikes are not stripped.
- Prompt execution tests prove canonical submission bytes and member order are
  unchanged.
- Existing redaction and 96-character bounds remain effective.
- Run focused Red-Green tests, then all 252 Vitest files, typecheck, build, and
  public audit before deployment.
- Commit as `fix(cards): hide Feishu batch envelopes from reply context` with no
  AI co-author trailer.

**Blocked by:** None. Implement after T1 only to preserve the approved live
deployment order; there is no source dependency between the tickets.

## Final delivery checks

1. Review both complete diffs against the specification and verify only the
   named task files are staged in each repository.
2. Stop or otherwise quiesce the Core journal writer, take a consistent backup
   of the database and any WAL/SHM companions, install the T1 release binary,
   and verify journal v4 plus Pane/session identity preservation.
3. Recover the two detached Prompts only through their existing submission IDs
   (`a02a9b40-643b-49f1-8f99-b575fe07f2be` and
   `b50464a0-d63c-43ac-b185-b57f6983d496`) and durable receipt/turn evidence.
   Do not create replacement IDs or bulk-replay historical rows.
4. Build and install the T2 Swarm release, use the supported restart safety
   gate, and verify `/ready`, build identity, the affected Binding, and card
   convergence.
5. Confirm the Answer subtitle no longer shows the outer Feishu envelope while
   the durable execution body is unchanged. Record any unrelated degraded
   status or historical dead letters separately.
6. Do not push, open a pull request, delete worktrees, or modify the dirty shared
   Core checkout.
