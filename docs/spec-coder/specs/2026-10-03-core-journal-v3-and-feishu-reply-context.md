# Core Journal v3 Recovery and Feishu Reply Context

## Problem Statement

Two independent regressions block or degrade the same Feishu-to-Herdr flow.

1. The deployed Herdr event journal at `~/.config/herdr/agent-events/events.db`
   has `PRAGMA user_version=3`, while the currently deployed candidate Core was
   built from a branch whose richer recovery journal accepts only versions up
   to 2. Every Agent event command therefore fails before submission with
   `unsupported_journal_version`.
2. A Native Input Batch deliberately stores an execution body such as
   `[Feishu message 1/1]\nprogress`, but the Answer header currently derives its
   Reply Context from that execution body. The transport envelope consequently
   appears in the user-visible subtitle even though it is not part of the
   user's message.

The affected live Prompts are detached/recovering. They must not be replayed
under a new identity or globally reset while the repair is deployed.

## Solution

Upgrade the richer Core journal to schema version 4. On open, identify the
deployed version-3 `pending_submissions` shape and transactionally translate it
to the richer receipt schema. Preserve exact evidence when present and map any
state without exact turn evidence conservatively so reopening the journal can
never manufacture permission to resend a Prompt. Existing rich version-2
journals upgrade without losing their recovery fields; new journals are created
directly at version 4. Unsupported or ambiguous shapes continue to fail closed.

Separately, make Reply Context an explicit presentation value on the Swarm Run
Projection. Native Input Batch admission derives it from original Feishu
message bodies, while `Prompt.body`, `NativeInputBatch.combinedBody`,
`RunCardView.requestText`, and the Core submission text remain unchanged. For
historical Run Projections that lack the new optional value, the presentation
boundary may unwrap only a complete, canonical Native Input Batch envelope;
otherwise it preserves the existing request text exactly. Redaction,
single-line normalization, and the existing 96-character bound remain in force.

No public command, Core API, Pane identity, Binding identity, native session,
Feishu thread, or card identity changes.

## User Stories

### SCN-1: Reopen a deployed journal

When Core opens the current deployed version-3 journal, it migrates the known
schema to version 4 and Agent event commands become available without deleting
event history or submission receipts.

### SCN-2: Preserve no-replay safety

When a deployed receipt does not prove an exact accepted turn, migration keeps
it non-replayable. Recovery of a live detached Prompt uses its original
`submission_id`; no new submission identity is generated and no historical
Prompt is bulk replayed.

### SCN-3: Render a single Feishu message

For an execution body `[Feishu message 1/1]\nprogress`, the Answer subtitle is
`Reply to 👤 progress`. The full enveloped execution body remains available to
durable batching and submission logic.

### SCN-4: Render multiple and literal-envelope messages

For a multi-message batch, Reply Context is derived from the original member
bodies in order. If the user literally types text beginning with
`[Feishu message 1/1]`, only the bridge-owned outer envelope is removed; the
user's literal text remains visible and is still submitted unchanged.

### SCN-5: Preserve non-batch and historical projections

Non-batch Run Projections retain their current Reply Context. Historical batch
projections without the new field render without the bridge-owned envelope when
their request text is a complete canonical batch, and malformed or partial
lookalikes are left unchanged.

## Implementation Decisions

### Domain Model

The Core journal owns durable submission receipts and their evidence. Its
invariant is: a schema migration may discard replay eligibility when evidence is
insufficient, but must never invent acceptance, correlation, turn identity, or
permission to submit again. SQLite migration remains one transaction under the
existing journal writer lock.

The Swarm Conversation Projection owns **Reply Context**, a bounded display
summary distinct from the execution Prompt. Native Input Batching owns the
transport envelope and ordered source bodies. The Prompt aggregate continues to
own the exact durable execution body. A presentation repair may interpret an
old canonical envelope but may not rewrite Prompt or batch state.

### Architecture

- Core keeps migration and schema-shape validation inside
  `src/agent_events/journal.rs`; no API or caller learns SQLite details.
- Swarm batch formatting/parsing remains in the Native Input Batch domain
  module. Batch admission supplies the optional Reply Context when creating a
  Run Projection.
- Answer header projection consumes Reply Context and retains a legacy fallback
  for persisted views created before this change. Card rendering does not query
  SQLite or mutate workflow state.
- Existing composition, ports, and external command contracts remain unchanged.

### Behavior & Failure Modes

- A version greater than 4 remains `unsupported_journal_version`.
- A known version with an unexpected table shape fails with
  `unsupported_journal_schema`; it is not partially migrated.
- Version-3 receipt conversion is conservative. Rows without richer turn facts
  remain unavailable for automatic replay. No fabricated `transcript_id`,
  `turn_id`, or terminal outcome is written.
- The migration commits atomically or leaves the version-3 database intact.
- Reply Context parsing succeeds only when the entire string is a canonical
  one-to-three-message envelope with contiguous matching ordinals and counts.
  Otherwise the original text is rendered after existing redaction/bounding.
- Delivery retry may update the same card, but it never repeats a Core prompt.

### Compatibility & Migration

Journal version 4 is intentionally not readable by the older deployed v3-only
binary. Before live cutover, copy the journal database together with any active
WAL/SHM companions while the owning Core process is stopped or through an
equivalent consistent SQLite backup. Rollback restores both the prior binary
and the matching database backup.

Run Projection Reply Context is optional for JSON compatibility and persists in
an additive nullable `run_cards.reply_context` column. Existing rows need no
destructive database migration; they retain `NULL`, and the legacy rendering
fallback repairs them when their cards next converge.

Deployment order is Core first, then Swarm. Core validation uses the original
submission IDs for the two detached Prompts. It must not generate a replacement
ID, invoke a bulk replay, or alter unrelated historical Prompt rows.

## Testing Decisions

- Add Core journal tests that create the deployed version-3 schema, cover each
  receipt-state mapping, verify `user_version=4`, reopen idempotently, and prove
  duplicate preparation cannot become a new submission. Keep existing v1,
  stream-v2, rich-v2, indexing, and recovery tests green.
- Observe the current `unsupported_journal_version` CLI reproduction before the
  fix and rerun the exact command with the same submission ID after deployment.
- Add Swarm domain tests for canonical batch parsing, malformed envelopes,
  multiple members, and nested literal envelope text.
- Add Answer header tests proving batch metadata is absent, non-batch behavior
  and redaction are unchanged, and old projections use the safe fallback.
- Add prompt-admission/execution assertions proving the submitted body retains
  its canonical envelope semantics and member order.
- Before each commit, run focused affected tests. For Swarm also run the full
  Vitest suite, typecheck, and build. For Core run format, Clippy, journal tests,
  and release build; retry `just check` and report the pre-existing CLI/PTY
  baseline failures separately if they remain.

## Out of Scope

- Replaying, cancelling, or bulk-reclassifying historical Prompts.
- Changing Native Input Batch execution syntax or batching windows.
- Rebuilding Feishu threads or changing Answer Card identities.
- Refactoring unrelated Core event schemas, process detection, PTY tests, or
  Swarm projection storage.
- Pushing branches, opening pull requests, or editing the dirty shared Core
  checkout.

## Further Notes

- Swarm workspace: isolated existing worktree
  `/tmp/herdr-agent-swarm-orchestrator-fixed-identity`, branch
  `feat/orchestrator-fixed-identity`, starting revision
  `4bcb95c6a7fa1891fa5437c94668e666a148dd47`, initially clean.
- Core workspace: isolated existing worktree
  `/tmp/herdr-core-journal-v2-recovery-rotation`, branch
  `fix/journal-v2-recovery-session-rotation`, starting revision
  `ea1d35dfe436bc28de90eddbf0d4286b174c4ea6`, initially clean.
- Swarm fresh baseline: 252 test files and 3,642 tests passed; typecheck and
  build passed; build identity remained
  `sha256:eada1a8f67c35938d4710e92ab5a1dbc82e0429c279fd012fc9d9df2f9fa0045`.
- Core accepted narrow baseline: `cargo fmt --check` and Clippy passed with Zig
  0.16.0; `just test-one journal` passed 19/19. Full `just check` has eight
  reproducible pre-existing CLI/PTY failures involving `pi` being detected as
  `codex`, an early `agent_not_running`, and foreground-CWD marker timeouts. The
  user explicitly authorized continuing with the narrow baseline and a final
  full-suite retry.
- Approved commit subjects:
  `fix(agent-events): migrate deployed journal v3` and
  `fix(cards): hide Feishu batch envelopes from reply context`.
