# SQLite Prompt Queue Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and verify a composite SQLite index that removes residual dispatch-kind filtering from ordinary prompt queue hot paths without changing queue behavior.

**Architecture:** Extend the canonical schema and idempotent query-index repair with `prompt_jobs_queue_kind(binding_id, state, dispatch_kind, created_at)`. Keep all production queries and existing indexes unchanged; use representative mixed data plus `ANALYZE` and `EXPLAIN QUERY PLAN` only in tests to prove planner eligibility and selection.

**Tech Stack:** TypeScript, Node.js built-in SQLite, Vitest, SQLite EXPLAIN QUERY PLAN

**Spec:** `docs/superpowers/specs/2026-08-29-sqlite-prompt-queue-index-design.md`

## Global Constraints

- Preserve one ordinary running turn per binding and FIFO by `created_at`, then rowid.
- Preserve ordinary/steering isolation and all Answer Card, running-turn, and model-control fences.
- Do not add `INDEXED BY` to production SQL.
- Keep `prompt_jobs_queue` and `prompt_jobs_dispatch` in this increment.
- Migrations must be idempotent for new, upgraded, and repeatedly reopened databases.
- Do not stage or modify unrelated dirty-worktree files.

---

### Task 1: Lock the index and query-plan contract with tests

**Files:**
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `SqliteBindingStore.database`, SQLite `PRAGMA index_info`, `ANALYZE`, and `EXPLAIN QUERY PLAN`.
- Produces: regression tests for exact index shape, repair on reopen, no-op reopen, and ordinary queue hot-path planner selection.

- [ ] **Step 1: Add a failing exact-shape test**

Create a fresh store and assert:

```ts
const columns = store.database.prepare("PRAGMA index_info(prompt_jobs_queue_kind)").all() as Array<{ name: string }>;
expect(columns.map((column) => column.name)).toEqual(["binding_id", "state", "dispatch_kind", "created_at"]);
```

- [ ] **Step 2: Add a failing repair and idempotency test**

Create a file-backed store, drop `prompt_jobs_queue_kind`, close and reopen it, then assert the index exists. Close/reopen once more and assert `PRAGMA schema_version` is unchanged on the no-op reopen.

- [ ] **Step 3: Add failing representative query-plan tests**

Populate multiple bindings with at least 1,000 mixed queued/delivered ordinary and steering prompt rows using direct fixture SQL, run `ANALYZE`, and inspect production-equivalent SQL for:

1. queued ordinary prompt listing;
2. next dispatchable ordinary prompt selection, including the Run Card join and fences; and
3. the ordinary-turn branch of durable safety scanning.

Normalize all returned `detail` strings and assert each prompt candidate access uses `prompt_jobs_queue_kind` with the leading equality predicates. Do not force the index in the explained SQL.

- [ ] **Step 4: Run tests and confirm the expected red state**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts
```

Expected: the new index shape, repair, and planner assertions fail because the index does not exist.

- [ ] **Step 5: Commit only if test-first commits are desired**

Do not commit the red state by default. Keep it local for Task 2 so the implementation commit remains atomic.

---

### Task 2: Add the idempotent composite index

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: the existing canonical schema and `ensureQueryIndexes()` repair hook.
- Produces: `prompt_jobs_queue_kind(binding_id, state, dispatch_kind, created_at)` on every supported database.

- [ ] **Step 1: Extend the canonical schema**

Immediately after the existing `prompt_jobs_queue` definition, add:

```sql
CREATE INDEX IF NOT EXISTS prompt_jobs_queue_kind
ON prompt_jobs(binding_id, state, dispatch_kind, created_at);
```

- [ ] **Step 2: Extend the idempotent repair path**

Add the same `CREATE INDEX IF NOT EXISTS` statement to `ensureQueryIndexes()`. Do not add a numbered data migration because no rows or columns change.

- [ ] **Step 3: Run the focused store suite**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts
```

Expected: all store tests pass, including exact shape, repair, schema idempotency, query-plan assertions, FIFO, queue isolation, and dispatch fences.

- [ ] **Step 4: Run concurrency regression tests**

Run:

```bash
npx vitest run tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts
```

Expected: one-turn concurrency and steering behavior remain unchanged.

- [ ] **Step 5: Run static and build verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 6: Review the diff against the design**

Confirm production changes contain only the two index creation statements, production queries have no `INDEXED BY`, and existing indexes are retained.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/store/sqlite-store.ts tests/sqlite-store.test.ts
git commit -m "perf: index ordinary prompt queue lookups"
```

---

### Task 3: Repository-wide verification and operational handoff

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the committed index and existing test/build/service lifecycle commands.
- Produces: final verification evidence and a safe deployment decision.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
npm test
```

Expected: every Vitest file and test passes.

- [ ] **Step 2: Re-run build after the final commit**

Run:

```bash
npm run build
```

Expected: `dist/build-info.json` contains the implementation commit identity.

- [ ] **Step 3: Restart only when the durable queue is idle**

Run:

```bash
npm run swarm:restart
npm run swarm:status
```

Expected: the safety gate permits restart, the standalone service is active, readiness is `ready`, and expected/observed build IDs and Git commits match. Do not use `--force` and do not restart the compatibility service.

- [ ] **Step 4: Record follow-up evidence**

Capture the before/after query plans, test totals, build ID, and restart result in the handoff. Do not claim wall-clock latency improvement from query plans alone; runtime benchmarking and old-index removal remain separate future work.
