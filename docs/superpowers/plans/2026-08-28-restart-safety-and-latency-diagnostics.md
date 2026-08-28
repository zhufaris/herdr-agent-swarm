# Restart Safety and Latency Diagnostics Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block accidental restarts during active TraeX turns and expose bounded prompt latency aggregates through `/status`.

**Architecture:** Extend the existing SQLite operational summary with read-only aggregates over a fixed recent prompt window. Add a lifecycle CLI preflight that reads the running service's `/status` before mutating the systemd unit, while retaining an explicit force escape hatch and the existing post-restart identity checks.

**Tech Stack:** TypeScript, Node.js HTTP, SQLite, systemd user units, Vitest

**Spec:** `docs/superpowers/specs/2026-08-28-restart-safety-and-latency-diagnostics-design.md`

## Global Constraints

- Preserve FIFO ordering, steering behavior, and detached no-replay recovery.
- Do not expose prompt text, Lark payloads, user identity, or secrets.
- Keep status aggregation bounded and read-only.
- Reject only a reachable, valid service status that proves active work exists.
- `--force` bypasses the active-work guard only.
- Preserve unrelated uncommitted workspace changes.

---

### Task 1: Bounded Prompt Latency Summary

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/health-server.test.ts`

**Interfaces:**
- Produces: `OperationalSummary.promptLatency` with `windowSize`, `sampleCount`, and queue/execution/delivery phase aggregates.
- Consumes: existing `prompt_jobs.created_at`, `run_cards.started_at` and `finished_at`, plus delivered `stream_finish` outbox timestamps.

- [x] Add a failing store test with completed, running, and incomplete timestamp rows.
- [x] Assert empty phases use `{ sampleCount: 0, averageMs: null, maxMs: null }`.
- [x] Add the typed `PromptLatencySummary` contract.
- [x] Implement one bounded SQLite query over the latest 100 terminal prompts and map seconds to non-negative integer milliseconds.
- [x] Assert `/status` returns the aggregate and does not expose prompt content.
- [x] Run `npx vitest run tests/sqlite-store.test.ts tests/health-server.test.ts`.

### Task 2: Safe Restart Preflight

**Files:**
- Modify: `src/cli/plugin-lifecycle.ts`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Produces: `runPluginLifecycle(action, environment, options?)`, where `options.force` is valid only for restart.
- Consumes: `/status` fields `identity.serviceId`, `operational.prompts.running`, `operational.prompts.queued`, and `promptWorker.activeTurnWorkers`.

- [x] Add a failing test that a reachable matching service with active work rejects restart before `daemon-reload`.
- [x] Add a failing test that forced restart proceeds and still performs post-restart health checks.
- [x] Add coverage for idle, unreachable, malformed, mismatched-service, and old-build status responses.
- [x] Parse CLI arguments as `<action> [--force]` and reject `--force` for other actions.
- [x] Implement the bounded preflight probe and aggregate-only error message.
- [x] Run `npx vitest run tests/plugin-lifecycle.test.ts`.

### Task 3: Full Verification and Deployment

**Files:**
- Verify all modified source and test files.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a verified build and a safely restarted standalone service.

- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [ ] Check `/status`; wait until `prompts.running` and `promptWorker.activeTurnWorkers` are both zero.
- [ ] Restart through the lifecycle CLI without `--force`, proving the preflight permits a drained service.
- [ ] Verify `/ready`, build identity, prompt latency output, Lark readiness, Herdr readiness, and empty/stable outbox.
- [ ] Commit only restart-safety/latency files and this plan; leave unrelated Lark/Answer changes untouched.
