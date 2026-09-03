# Runtime Tuning Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated operator configuration for four runtime cache, scan, and debounce intervals while preserving defaults.

**Architecture:** `loadConfig` owns validation and returns one `runtimeTuning` group. The composition root injects values into existing constructors, while constructor defaults remain for direct consumers and tests.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js timers.

**Spec:** `docs/superpowers/specs/2026-08-29-runtime-tuning-configuration-design.md`

## Global Constraints

- Preserve defaults: 2000, 30000, 750, and 100 milliseconds respectively.
- Do not configure protocol, security, parser, or payload safety limits.
- Do not add dependencies or live reload.
- Preserve unrelated main-worktree WIP during integration.

---

### Task 1: Validated configuration surface

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `config.runtimeTuning.{herdrSnapshotCacheTtlMs,outboxSafetyScanIntervalMs,cardUpdateDebounceMs,herdrEventDebounceMs}`.

- [ ] Add tests for exact defaults, explicit values, and every lower/upper bound.
- [ ] Run `npx vitest run tests/config.test.ts` and confirm failure.
- [ ] Add the four Zod fields and `runtimeTuning` output group.
- [ ] Run the focused test and commit.

### Task 2: Card scheduler injection

**Files:**
- Modify: `src/events/conversation-view-projector.ts`
- Test: `tests/event-card-integration.test.ts`

**Interfaces:**
- Consumes: optional `cardUpdateDebounceMs` projector option.
- Produces: `CardUpdateScheduler` constructed with that interval.

- [ ] Add a fake-timer test showing a custom interval controls deferred delivery.
- [ ] Run the focused test and confirm failure.
- [ ] Add the option and pass it into the scheduler without changing its default.
- [ ] Run the focused test and commit.

### Task 3: Composition-root wiring

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: all four `runtimeTuning` values.
- Produces: explicit constructor arguments for cache, outbox dispatcher, projector, and event inbox.

- [ ] Wire all four validated values at their existing construction sites.
- [ ] Run `npm run typecheck` and the config, event-card, outbox, cache, and event-inbox tests.
- [ ] Commit the wiring.

### Task 4: Verification and integration

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Integrate commits into `main` with hunk-level handling for overlapping files.
- [ ] Repeat focused and full verification in the real main worktree.
