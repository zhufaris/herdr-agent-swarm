# Bridge-Owned TraeX Session Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the exact TraeX SessionStart UUID directly in the bridge and use it for validated typed transcript output.

**Architecture:** A bridge-owned Unix socket accepts capability-authenticated, bounded SessionStart reports from bridge-created panes. SQLite stores the direct UUID separately from Herdr observations, and prompt execution prefers it while retaining the strict JSONL reader checks.

**Tech Stack:** Node.js Unix sockets, TypeScript, Zod, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-bridge-owned-traex-session-design.md`

## Global Constraints

- Never guess a transcript identity by cwd, time, title, or newest file.
- Do not replay a prompt after it may have reached TraeX.
- Keep the UUID, capability token, prompt, and transcript content out of logs and Lark.
- Do not represent bridge-reported identity as a Herdr-native session.
- Accept only `startup` and `resume`; use `/swarm reset` instead of local `/clear` for a new bridge-owned session.
- Treat the reporter as a SQLite writer during shutdown and drain or destroy all accepted sockets before releasing ownership.

---

### Task 1: Capability-bound SessionStart transport

**Files:**
- Create: `src/runtime/traex-session-reporter.ts`
- Modify: `src/cli/report-traex-session.ts`, `src/adapters/herdr-adapter.ts`, `src/main.ts`, `src/runtime/shutdown.ts`
- Test: `tests/report-traex-session.test.ts`, `tests/traex-session-reporter.test.ts`

**Interfaces:**
- Produces `TraexSessionReporter.start()` / `stop()` and the Pane environment injected by `HerdrCliAdapter`.

- [ ] Add failing reporter and socket tests for a valid capability-bound report and rejected malformed/token-invalid reports.
- [ ] Start a mode-0600 Unix socket before bridge runtime startup, generate a per-process token, inject it only into bridge-created panes, and report one bounded JSON line from the hook.
- [ ] Stop the socket before releasing SQLite ownership.
- [ ] Run `npx vitest run tests/report-traex-session.test.ts tests/traex-session-reporter.test.ts`.

### Task 1A: Review hardening for the SessionStart transport

**Files:**
- Modify: `src/infra/command-runner.ts`, `src/runtime/traex-session-reporter.ts`, `src/runtime/shutdown.ts`, `src/adapters/herdr-adapter.ts`, `src/cli/report-traex-session.ts`
- Test: `tests/command-runner.test.ts`, `tests/traex-session-reporter.test.ts`, `tests/runtime-shutdown.test.ts`, `tests/herdr-adapter.test.ts`, `tests/report-traex-session.test.ts`

**Interfaces:**
- Preserve `TraexSessionReporter.start()` / `stop()` and the existing Pane environment keys.
- Limit SessionStart source to `startup | resume`.

- [ ] Add a failing `CommandError` test proving the capability value is absent from `message`, `args`, and serialized output.
- [ ] Add a failing reporter test that holds a partial socket open and requires `stop()` to settle and unlink the socket.
- [ ] Add failing hook and CLI tests proving `clear` is not configured or reported.
- [ ] Redact sensitive `--env` values at the command boundary, track and destroy accepted reporter sockets, and treat reporter shutdown as writer settlement.
- [ ] Run `npx vitest run tests/command-runner.test.ts tests/traex-session-reporter.test.ts tests/runtime-shutdown.test.ts tests/herdr-adapter.test.ts tests/report-traex-session.test.ts`.

### Task 2: Durable direct identity and typed selection

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/ports.ts`, `src/store/sqlite-records.ts`, `src/store/sqlite-store.ts`, `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/sqlite-store.test.ts`, `tests/prompt-run-workflow.test.ts`

**Interfaces:**
- Adds `recordReportedTraexSession(input)` to `BindingStorePort`.
- Adds bridge-owned `reportedTraexSessionId` and timestamp to `Binding`.

- [ ] Add failing store tests for first write, duplicate idempotence, and conflicting/stale rejection.
- [ ] Add the additive SQLite migration and transactional conditional update.
- [ ] Prefer bridge-reported UUID when opening the already strict transcript reader.
- [ ] Run affected Vitest files, typecheck, and build.

### Task 3: Managed-service smoke verification

**Files:**
- Modify: none unless verification identifies a regression.

- [ ] Build and restart the linked bridge service.
- [ ] Create a fresh bridge binding and confirm its direct UUID is persisted without exposing it in logs.
- [ ] Send a safe short follow-up and confirm the turn selects typed transcript mode, or report the exact operational blocker without replaying it.

### Task 4: Honest typed tool rendering

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Preserve the canonical typed transcript cursor and source offsets.
- Render only explicit `exec.command` or `exec.cmd` fields as `bash`; retain generic `input` as JSON.

- [ ] Add a failing test showing that orchestration supplied through `exec.input` is rendered as JSON, not executable shell.
- [ ] Keep explicit `command` and `cmd` rendering as fenced bash.
- [ ] Run `npx vitest run tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts`.
