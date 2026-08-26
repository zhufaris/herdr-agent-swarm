# SQLite Integrity Audit Implementation Plan

> **For agentic workers:** Execute inline with red-green TDD. Do not delegate this plan.

**Goal:** Add bounded, cached, read-only SQLite integrity auditing that degrades operational status without failing readiness.

**Architecture:** The SQLite adapter owns physical and relational inspection. A runtime auditor schedules and caches it. The health server reads the cache; the composition root owns lifecycle wiring.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Vitest, Pino, Zod.

**Spec:** `docs/superpowers/specs/2026-08-26-sqlite-integrity-audit-design.md`

## Global constraints

- Read-only inspection; never repair data automatically.
- Preserve prompt no-replay, FIFO, steering, Herdr authority, and CardKit behavior.
- Keep issue output bounded to 20 records and exclude user content and durable identifiers.
- Degrade `/status` only; do not change `/ready`.
- Run once at startup and every 900000 ms by default; stop before SQLite closes.

### Task 1: Store integrity seam

**Files:** Modify `src/domain/types.ts`, `src/domain/ports.ts`, `src/store/sqlite-store.ts`; test `tests/sqlite-store.test.ts`.

**Produces:** `DatabaseIntegrityStore.inspectIntegrity(limit: number): SqliteIntegrityInspection`.

- [ ] Add a failing test for a healthy database returning `quickCheck: "ok"` and no issues.
- [ ] Implement the result types and physical checks.
- [ ] Add one failing test per business invariant using intentionally inconsistent test rows.
- [ ] Implement parameter-free aggregate queries and cap returned issue records at the requested limit.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts`.

### Task 2: Cached runtime auditor

**Files:** Create `src/runtime/sqlite-integrity-auditor.ts`; test `tests/sqlite-integrity-auditor.test.ts`.

**Consumes:** `DatabaseIntegrityStore.inspectIntegrity(limit)`.

**Produces:** `start()`, `run()`, `stop()`, and `snapshot(): SqliteIntegrityDiagnostics`.

- [ ] Write failing tests for healthy/degraded snapshots, coalesced concurrent calls, and caught exceptions.
- [ ] Implement immediate and interval execution with an unreferenced timer.
- [ ] Bound errors and retain the last completed result while a later run executes.
- [ ] Run `npx vitest run tests/sqlite-integrity-auditor.test.ts`.

### Task 3: Configuration, health, and lifecycle wiring

**Files:** Modify `src/config.ts`, `.env.example`, `src/health/server.ts`, `src/main.ts`, `src/runtime/shutdown.ts`, `tests/config.test.ts`, `tests/health-server.test.ts`, and `docs/architecture.md`.

**Consumes:** `SqliteIntegrityAuditor`.

**Produces:** `config.sqliteIntegrityAudit.intervalMs` and `/status.sqliteIntegrity`.

- [ ] Write failing configuration and health tests for the default interval and degraded-status/readiness split.
- [ ] Add validated configuration and health snapshot wiring.
- [ ] Start the auditor after lease acquisition and stop it before shutdown closes SQLite.
- [ ] Document the operational behavior and setting.
- [ ] Run the focused configuration, health, shutdown, and auditor tests.

### Task 4: Verification, commit, and deployment

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect the scoped diff.
- [ ] Commit only this feature's files, excluding pre-existing user changes.
- [ ] Restart through the Herdr plugin lifecycle action.
- [ ] Verify systemd is active, `/ready` is ready, `/status.sqliteIntegrity.state` is healthy, and the deployed build identity matches the fresh build.
