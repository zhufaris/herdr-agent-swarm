# Shim-Owned TraeX Session Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shim-reported Herdr `agent_session` the only TraeX session identity, remove the bridge-owned SessionStart socket and legacy columns, and prove exact JSONL observation across restart and recovery.

**Architecture:** The installed shim injects a bounded SessionStart hook that calls official Herdr with `pane report-agent --agent-session-id`. The bridge normalizes shim-marked Codex protocol sessions to TraeX at the adapter boundary, persists only canonical `agent_session_*`, and passes only that identity to the transcript reader.

**Tech Stack:** TypeScript ESM, Node.js 22+, Vitest, better-sqlite3, Bash, Herdr 0.7.5, TraeX hooks

**Spec:** `docs/superpowers/specs/2026-08-29-shim-owned-traex-session-identity-design.md`

## Global Constraints

- Do not retain the bridge SessionStart socket as a compatibility path.
- Do not write SQLite from the shim.
- Preserve exact argv boundaries and never log hook input or session content.
- Preserve no-replay, FIFO, generation fencing, and local approval behavior.
- Preserve unrelated worktree changes and exclude them from commits.
- Use the official absolute Herdr path from installed shim configuration.

---

### Task 1: Shim-owned SessionStart reporting

**Files:**
- Modify: `src/runtime/report-traex-lifecycle.ts`
- Modify: `src/cli/report-traex-lifecycle.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `scripts/install-herdr-traex-shim.sh`
- Modify: `tests/report-traex-lifecycle.test.ts`
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `tests/herdr-traex-shim-install.test.ts`

**Interfaces:**
- Consumes: TraeX hook JSON and `HERDR_PANE_ID` plus installer-owned `HERDR_TRAEX_REAL_HERDR`.
- Produces: `reportTraexLifecycle(rawInput, environment, run, sequence)` supporting SessionStart and lifecycle events; SessionStart emits `pane report-agent ... --state idle --agent-session-id <uuid>`.

- [ ] Add a failing SessionStart test with an exact UUID and assert exact Herdr argv.
- [ ] Add rejection tests for invalid UUID, unsupported source, missing Herdr context, and oversized input.
- [ ] Run `npx vitest run tests/report-traex-lifecycle.test.ts` and confirm the new assertions fail.
- [ ] Extend the bounded hook schema so SessionStart validates `session_id` and `startup|resume`, while prompt/stop reports never forward the session ID.
- [ ] Replace the bridge SessionStart hook in `HerdrCliAdapter.startAgent` with the lifecycle reporter using the official Herdr environment prefix.
- [ ] Update adapter tests to assert all three shim-owned hook arguments and absence of `report-traex-session.js`.
- [ ] Extend installer contract validation to require `--agent-session-id`; keep the lifecycle reporter in the copied import closure.
- [ ] Extend installer tests to reject a Herdr contract without that option and accept the supported contract.
- [ ] Run `npx vitest run tests/report-traex-lifecycle.test.ts tests/herdr-adapter.test.ts tests/herdr-traex-shim-install.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only Task 1 files as `feat: report TraeX sessions through Herdr`.

### Task 2: Normalize native TraeX session identity

**Files:**
- Modify: `src/runtime/herdr-traex-shim.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `tests/herdr-traex-shim.test.ts`
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `tests/herdr-runtime-reconciler.test.ts` only in non-overlapping hunks

**Interfaces:**
- Consumes: Herdr records where `agent=codex`, `display_agent=traex`, and `agent_session.agent=codex`.
- Produces: projected and adapter-normalized records where both runtime and session agent are `traex`, while source/kind/value are unchanged.

- [ ] Add failing projection tests for marked TraeX session identity and ordinary Codex non-rewrite.
- [ ] Add failing adapter tests for both snapshot and `agent get` paths.
- [ ] Run `npx vitest run tests/herdr-traex-shim.test.ts tests/herdr-adapter.test.ts`.
- [ ] Implement one recursive projection rule for marked records and one adapter normalization helper shared by snapshot paths.
- [ ] Verify provisioning and reconciliation persist the normalized canonical fields without changing mismatch fencing.
- [ ] Run `npx vitest run tests/herdr-traex-shim.test.ts tests/herdr-adapter.test.ts tests/herdr-runtime-reconciler.test.ts tests/pane-thread-lifecycle-integration.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only Task 2 changes as `fix: normalize shim TraeX session identity`.

### Task 3: Remove bridge-owned session reporting and legacy schema

**Files:**
- Delete: `src/cli/report-traex-session.ts`
- Delete: `src/runtime/traex-session-reporter.ts`
- Delete: `tests/report-traex-session.test.ts`
- Delete: `tests/traex-session-reporter.test.ts`
- Modify: `src/main.ts`
- Modify: `src/runtime/shutdown.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/runtime-shutdown.test.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Removes: `TraexSessionReporter`, `recordReportedTraexSession`, `reportedTraexSessionId`, `reportedTraexSessionAt`, and reporter environment injection.
- Retains: `agentSessionSource`, `agentSessionAgent`, `agentSessionKind`, and `agentSessionValue`.

- [ ] Add a failing migration test that opens a legacy database, preserves binding data, and asserts the obsolete columns are absent after initialization.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the migration test fails.
- [ ] Add an idempotent transactional migration that drops the two obsolete, unreferenced columns while preserving canonical columns, constraints, indexes, and rows.
- [ ] Remove legacy binding fields, store method, SQL writes, socket server, startup/shutdown ownership, and pane environment injection.
- [ ] Delete the obsolete reporter modules and their focused tests.
- [ ] Update shutdown tests so writer ordering and deadline assertions no longer include the removed reporter.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/runtime-shutdown.test.ts tests/project-selection-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only Task 3 files as `refactor: remove bridge-owned TraeX sessions`.

### Task 4: Canonical transcript selection and recovery

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `tests/concurrency-controls.integration.test.ts`
- Modify: `tests/traex-transcript.test.ts` if additional exact-path coverage is needed
- Modify: `tests/herdr-runtime-reconciler.test.ts` only in non-overlapping hunks

**Interfaces:**
- Consumes: the persisted canonical `agent_session_*` tuple.
- Produces: one `HerdrAgentSession` passed to `TraexTranscriptReader.open`; no fallback identity.

- [ ] Replace fixtures that seed `reportedTraexSessionId` with canonical TraeX session tuples.
- [ ] Add or update tests for delayed canonical identity, missing identity, transcript-not-found retry, exact JSONL match, and no replay after identity uncertainty.
- [ ] Run `npx vitest run tests/concurrency-controls.integration.test.ts tests/traex-transcript.test.ts` and confirm failures before the workflow change.
- [ ] Remove reported-session preference and poll only the complete canonical tuple.
- [ ] Preserve UUID/path/session-meta validation and the bounded first-turn grace.
- [ ] Run `npx vitest run tests/concurrency-controls.integration.test.ts tests/traex-transcript.test.ts tests/herdr-runtime-reconciler.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only Task 4 changes as `refactor: read TraeX transcripts from Herdr sessions`.

### Task 5: Documentation, full verification, and live rollout

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md` if it references the bridge-owned session reporter
- Modify: `docs/superpowers/specs/2026-08-29-herdr-traex-kind-shim-design.md` to remove the stale statement that the bridge owns SessionStart

**Interfaces:**
- Consumes: the committed clean-cut implementation.
- Produces: implementation-backed operational documentation and live verification evidence.

- [ ] Document the authority chain `TraeX SessionStart -> shim -> Herdr agent_session -> SQLite canonical fields -> exact JSONL`.
- [ ] Document failure behavior: missing identity degrades structured output and never replays a prompt.
- [ ] Run focused suites for shim, adapter, store, reconciliation, transcript, prompt concurrency, and shutdown.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit documentation as `docs: document native TraeX session identity`.
- [ ] Run `npm run herdr:traex:install` and `npm run herdr:traex:status`; record the installed release ID.
- [ ] Restart with the repository's normal safety-gated service command; do not use a force bypass.
- [ ] Verify service readiness, expected/observed build identity, zero new failed prompts, and no stalled outbox lanes.
- [ ] Create or use a fresh managed TraeX pane without sending a synthetic Lark message, then verify Herdr exposes the exact UUID in `agent_session`.
- [ ] Verify that UUID resolves to exactly one JSONL whose `session_meta.payload.id` matches and that bounded typed reading succeeds.
- [ ] Confirm `reported_traex_session_id`, `reported_traex_session_at`, the socket file, and bridge SessionStart hook no longer exist.

## Completion audit

- [ ] Every explicit design requirement maps to an implementation diff or test.
- [ ] Each batch has a dedicated commit and excludes unrelated pre-existing changes.
- [ ] The full test/build evidence is fresh after the final source change.
- [ ] Installed shim and running service identities match the committed build.
- [ ] Live Herdr session identity and exact JSONL reading are directly observed.
- [ ] No bridge-owned session compatibility surface remains in source, schema, runtime files, or process argv.
