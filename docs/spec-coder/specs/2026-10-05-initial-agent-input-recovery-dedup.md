# Initial Agent Input Recovery Deduplication

## Problem Statement

Startup recovery lists completed project selections with initial text whenever no legacy `prompt_jobs` row references the command message. After the Agent Input cutover, a completed selection can already have a durable Submission Intent while still having no legacy Prompt row. Startup then reconstructs the request from the current Binding identity, conflicts with the immutable existing intent, and attempts to rewrite an already delivered rejection effect. The startup stage becomes degraded even though the original input is already observed.

## Solution

Treat the Submission Intent ledger as the current recovery authority. A completed project selection is eligible for initial-input submission only when both are absent:

- a legacy Prompt row for the command message;
- a Submission Intent for the exact Binding gateway and command-message source key.

Any Submission Intent state suppresses automatic replay because the immutable source key has already been admitted or terminally classified. The query remains read-only and indexed.

## User Stories

- **I1 — Modern duplicate:** an observed/prepared/uncertain/cancelled initial Submission Intent is not reconstructed during startup.
- **I2 — Exact gateway:** an intent from another gateway with the same source key does not suppress the Feishu selection.
- **I3 — Legacy compatibility:** an existing legacy Prompt continues to suppress startup submission.
- **I4 — Missing input:** a completed selection with neither authority remains recoverable.

## Implementation Decisions

### Domain Model

Project Selection owns provisioning choice; Submission Intent owns immutable Agent Input admission. Startup recovery may create missing admission but never re-admit a source identity already present in the Submission Intent ledger. State does not reopen eligibility.

### Architecture

`SqliteInboundProjectStore.listCompletedProjectSelectionsWithInitialPrompt()` joins the selected Binding only to obtain its gateway identity and uses the existing unique Submission Intent source index. No coordinator catch, outbox exception, replay, or data mutation is added.

### Behavior & Failure Modes

The selection remains recoverable when another gateway happens to reuse the same source key. Missing Binding behavior remains unchanged at the workflow boundary, where such selections are skipped. No Submission Intent or outbox row is modified.

### Compatibility & Migration

No schema migration is required. The legacy Prompt exclusion remains until historical Prompt evidence is retired.

## Testing Decisions

Extend the existing project-selection recovery query test: another-gateway intent keeps the selection eligible; exact-gateway intent removes it; legacy Prompt behavior and query-plan index evidence remain covered. Run the focused store test, full SQLite suite, typecheck, build, full suite, and review.

## Out of Scope

- cleaning historical Answer dead letters;
- retrying or changing any existing Submission Intent state;
- changing project-selection lifecycle or Binding provisioning.

## Further Notes

- Workspace: in-place on `main` at `/workspace/herdr-agent-swarm`.
- Starting revision: `f486b2d4a103c3d75ee3fcb7cd4b5a602b318a3e`.
- Preserved user files: modified `TODO.md` and existing untracked research/handoff documents.
- Fresh baseline: 274 files / 3,954 tests, typecheck, and build passed.
- Approval: covered by the user's standing authorization for recommended delivery-stability fixes through deployment.
