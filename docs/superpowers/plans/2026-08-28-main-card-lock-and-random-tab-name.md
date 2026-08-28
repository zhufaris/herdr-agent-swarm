# Main Card Lock Recovery and Random Tab Naming Implementation Plan

> **For agentic workers:** Implement inline; sub-agent delegation is not authorized for this repository task.

**Goal:** Recover Lark Main Cards rejected with code 230099 and preserve random four-character Herdr tab suffixes.

**Architecture:** Keep recovery inside the transactional SQLite outbox boundary, then use the existing dispatcher loop to deliver the replacement. Keep Herdr naming local to provisioning and independent from Lark-facing titles.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, Herdr CLI, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-28-main-card-lock-and-random-tab-name-design.md`

## Global Constraints

- Never replay a TraeX prompt as part of delivery recovery.
- Do not clear the old Main Card pointer before replacement delivery succeeds.
- New and reset Herdr tabs use `task-xxxx`; prompt text is not a tab name.
- Preserve unrelated worktree changes.

### Task 1: Main Card rollover

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`

- [x] Add red tests for transactional rollover and dispatcher convergence.
- [x] Add the narrow 230099 Main Card transition.
- [x] Run both focused tests.

### Task 2: Random Herdr names

**Files:**
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Test: `tests/project-selection-integration.test.ts`

- [x] Assert titled and natural-language creation use `task-xxxx`.
- [x] Generate pane names independently of requested title and prompt.
- [x] Run the project-selection integration tests.

### Task 3: Repository and runtime verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Restart through the Herdr plugin and verify health, readiness, and provisioning convergence.
