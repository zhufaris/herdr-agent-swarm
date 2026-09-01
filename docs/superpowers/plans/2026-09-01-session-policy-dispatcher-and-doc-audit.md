# Session Policy, Dispatcher, and Documentation Audit Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session. Do not delegate unless the user explicitly requests sub-agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject impossible Session operations atomically, reuse one coalescing drain runtime, and make historical documentation archival auditable.

**Architecture:** A pure domain policy guards durable Session acceptance, while execution retains dynamic checks. A callback-based runtime owns only single-flight lifecycle mechanics. A declarative archive manifest drives a read-only repository audit.

**Tech Stack:** TypeScript ESM, Node.js, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-session-policy-dispatcher-and-doc-audit-design.md`

## Global Constraints

- Preserve atomic interaction consumption and Session-operation insertion.
- Keep existing SQLite enum values readable for upgrade compatibility.
- Never replay an operation that may have reached Herdr.
- Documentation auditing must not modify files.
- Do not include the untracked root `TODO.md`.

---

### Task 1: Reject unsupported and state-ineligible Session work

**Files:**
- Create: `src/domain/session-operation-policy.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/session-operation-workflow.ts`
- Test: `tests/session-operation-policy.test.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/session-operation-workflow.test.ts`

**Interfaces:**
- Consumes: `Binding`, `SessionOperationKind`.
- Produces: `sessionOperationRejection(binding, kind): string | null`.

- [ ] Add failing matrix tests for active, archived, and orphaned bindings.
- [ ] Add a failing persistence test proving policy rejection leaves the More Actions interaction active and inserts no operation.
- [ ] Add a failing dispatcher test proving a persisted `model` row becomes rejected and `runModel` is never called.
- [ ] Implement the pure policy and call it inside the existing acceptance transaction.
- [ ] Finalize legacy model rows directly with the standard unsupported-model reason.
- [ ] Run `npx vitest run tests/session-operation-policy.test.ts tests/sqlite-store.test.ts tests/session-operation-workflow.test.ts`.

### Task 2: Extract the coalescing drain runtime

**Files:**
- Create: `src/runtime/coalescing-drain.ts`
- Create: `tests/coalescing-drain.test.ts`
- Modify: `src/coordinator/session-operation-workflow.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `tests/session-operation-workflow.test.ts`
- Modify: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: owner callbacks `drain(): Promise<void>` and `onError(error): void`.
- Produces: `start`, `request`, `wake`, `stop`, and a bounded lifecycle snapshot.

- [ ] Add failing runtime tests for coalescing, periodic wake-up, errors, and stop.
- [ ] Implement single-flight lifecycle state without retry policy or business state.
- [ ] Replace Session dispatcher lifecycle fields with the runtime.
- [ ] Replace inbound single-flight fields with the runtime while retaining the inbound retry timer and diagnostics.
- [ ] Run `npx vitest run tests/coalescing-drain.test.ts tests/session-operation-workflow.test.ts tests/concurrency-controls.integration.test.ts`.

### Task 3: Add a repeatable documentation archive audit

**Files:**
- Create: `docs/superpowers/archive-manifest.json`
- Create: `scripts/audit-superpowers-docs.mjs`
- Create: `tests/docs-audit.test.ts`
- Modify: `package.json`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: manifest entries with `source`, `destination`, `status`, `reason`, and optional `supersededBy`.
- Produces: `npm run docs:audit`, a read-only validation command with nonzero exit on drift.

- [ ] Add failing fixture tests for missing destinations, active-source conflicts, duplicate paths, root escapes, and active links to archived sources.
- [ ] Implement the audit script with exported validation logic and a CLI entrypoint.
- [ ] Record only the historical files already moved in this worktree.
- [ ] Document the archive workflow and run `npm run docs:audit`.

### Task 4: Verify and commit by theme

**Files:**
- Inspect: all modified and untracked files except `TODO.md`.

- [ ] Run focused tests after each implementation batch.
- [ ] Run `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:audit`, and `git diff --check`.
- [ ] Inspect each staged diff and commit independently: design/plan, Session durability and cleanup, awake/transcript recovery, inbound/outbox/runtime reliability, service lifecycle, and docs/archive audit.
- [ ] Confirm `TODO.md` remains untracked and no deployment or restart occurred.
