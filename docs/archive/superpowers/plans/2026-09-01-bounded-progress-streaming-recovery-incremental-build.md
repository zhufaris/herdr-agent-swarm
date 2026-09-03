# Bounded Runtime Optimizations Implementation Plan

> **For agentic workers:** Execute these tasks inline in order. Each task is independently testable and must be committed separately.

**Goal:** Bound durable progress state, make detached-turn transcript boundary discovery constant-memory, and accelerate repeated TypeScript compilation with isolated incremental caches.

**Architecture:** Extend the Run Card and Topic View projections with cumulative progress metadata while retaining only eight recent events; keep the transcript reader's existing exact ownership fence but replace its whole-file allocation with a byte-oriented chunk scanner; keep emitted build artifacts unchanged while storing build and typecheck compiler state under separate ignored cache paths.

**Tech Stack:** TypeScript ESM, Node.js 22+, node:sqlite, Vitest, Bash/npm scripts.

**Spec:** `docs/superpowers/specs/2026-09-01-bounded-progress-streaming-recovery-incremental-build-design.md`

## Global Constraints

- Preserve the 64 MiB detached-turn recovery ceiling and exact `(turnId, startedAt)` fence.
- Never replay or submit a prompt from recovery code.
- Retain at most eight recent progress events while preserving total and step completion counts.
- Migrate existing SQLite rows idempotently without deleting legacy-readable data before deriving the summary.
- Keep build and typecheck compiler caches separate and outside `dist/`.
- Do not modify or commit `TODO.md` or `docs/herdr-agent-swarm-architecture.svg`.
- Do not install, restart, deploy, push, or mutate a live service.

---

### Task 1: Bound progress projections with cumulative summaries

**Files:**
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/domain/topic-view.ts`
- Modify: `src/cards/progress-timeline.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/run-card-view.test.ts`
- Test: `tests/topic-view.test.ts`
- Test: `tests/progress-timeline.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produce `RunProgressSummary = { total: number; stepTotal: number; stepDone: number }`.
- Add `progressSummary: RunProgressSummary` to `RunCardView` and `TopicViewState`.
- Change `renderProgressTimeline(events, phase, options)` so `options.summary` can supply cumulative totals.
- Persist `run_cards.progress_summary_json` and expose it through `run_cards_view.state_json`.

- [ ] Add reducer tests that feed more than eight distinct events, update retained steps across the `done` boundary, and assert `progressEvents.length === 8` while cumulative totals remain correct.
- [ ] Add snapshot tests proving an authoritative snapshot replaces the retained window and recomputes its summary.
- [ ] Implement one bounded merge helper shared by Run Card and Topic View reducers; preserve stable order for retained-key updates.
- [ ] Add the idempotent SQLite column, backfill summary values from legacy `progress_events_json`, trim legacy arrays to the newest eight entries, and rebuild `run_cards_view` when needed.
- [ ] Update Answer/Main Card renderers to use cumulative totals for omitted counts and step completion labels.
- [ ] Run `npx vitest run tests/run-card-view.test.ts tests/topic-view.test.ts tests/progress-timeline.test.ts tests/run-card.test.ts tests/sqlite-store.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only this task as `perf: bound progress projections`.

### Task 2: Stream detached-turn transcript recovery

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Preserve `findCompletedTurnBoundary(path, end, turnId, startedAt): Promise<number | "missing" | "incomplete">`.
- Add a fixed recovery chunk size and a bounded single-record carry limit.

- [ ] Add tests with padding and multibyte UTF-8 data that split `task_started` and `task_complete` JSONL records across chunk boundaries.
- [ ] Add a test for a matching interrupted turn followed by a split next-turn record and assert recovery begins exactly at that next turn.
- [ ] Replace `Buffer.alloc(end)` and whole-string splitting with sequential `FileHandle.read` calls, newline byte searches, and an exact absolute record-start offset.
- [ ] Process the final unterminated record, ignore invalid JSON as before, and fail closed when one record exceeds the bounded carry limit.
- [ ] Run `npx vitest run tests/traex-transcript.test.ts tests/external-turn-observer.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only this task as `perf: stream transcript recovery scans`.

### Task 3: Isolate TypeScript incremental compiler caches

**Files:**
- Modify: `tsconfig.json`
- Create: `tsconfig.typecheck.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `tests/standalone-install.test.ts`

**Interfaces:**
- Build cache: `.cache/tsconfig.build.tsbuildinfo`.
- Typecheck cache: `.cache/tsconfig.typecheck.tsbuildinfo`.
- `npm run build` continues to clean and emit `dist`, then generate `dist/build-info.json`.
- `npm run typecheck` extends the build configuration but emits no files and uses its own build-info path.

- [ ] Add build-contract assertions for `incremental`, both exact cache paths, distinct build/typecheck configs, and `.cache/` ignore coverage.
- [ ] Enable incremental compilation in `tsconfig.json` with the build cache path.
- [ ] Add `tsconfig.typecheck.json` with `noEmit: true` and the typecheck cache path; update the npm script to use it.
- [ ] Confirm production staging still copies only `dist`, `package.json`, and `package-lock.json`.
- [ ] Run `npx vitest run tests/standalone-install.test.ts tests/clean-dist.test.ts tests/build-identity.test.ts`.
- [ ] Run `npm run typecheck` twice, `npm run build` twice, and assert both cache files exist while `git status --short` does not list them.
- [ ] Run `git diff --check`.
- [ ] Commit only this task as `build: enable isolated incremental compilation`.

### Task 4: Full repository verification

**Files:**
- No production changes expected.

**Interfaces:**
- Consume the three committed task outputs and verify their combined behavior.

- [ ] Run `npm test`.
- [ ] Run `npx tsc -p tsconfig.typecheck.json --noUnusedLocals --noUnusedParameters`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run docs:audit`.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Confirm only user-owned untracked files remain and report all commit IDs without pushing.
