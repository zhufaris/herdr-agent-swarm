# Main Card Visual Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task in the current session. Do not delegate because this repository task explicitly disallows sub-agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Main Card into a compact status-focused panel without changing its durable data sources.

**Architecture:** Keep `TopicViewState` and all projection boundaries unchanged. Refine only the pure CardKit renderer: combine status and plan presentation, suppress duplicated summaries when live status exists, compact Answer preview, and move runtime identity into a footer.

**Tech Stack:** TypeScript, Lark CardKit schema 2.0, Vitest

**Spec:** `docs/superpowers/specs/2026-08-27-main-card-visual-hierarchy-design.md`

## Global Constraints

- Main Card consumes only `TopicViewState`; Answer Card behavior and source offsets must remain unchanged.
- Reasoning body, tool arguments, approval transcript, and protocol text must never render.
- The complete plan remains available, with `✔`, `■`, `◻`, and `✕` state markers.
- Legacy views without `liveStatus` retain the existing fallback presentation.
- No new dependency and no persisted schema change.

---

### Task 1: Lock the status-focused CardKit shape

**Files:**
- Modify: `tests/run-card.test.ts`
- Modify: `src/cards/run-card.ts`

**Interfaces:**
- Consumes: `renderProjectEntryCard(input: TopicViewState): object` and `TopicViewState.liveStatus`.
- Produces: one live-work panel, compact preview, secondary recent activity, and bottom runtime footer.

- [x] **Step 1: Write failing renderer assertions**

Add assertions that a card with `liveStatus` places the status panel before recent activity, does not contain the redundant `当前工作` block, uses one primary live-work panel, limits the latest-message tail to four meaningful lines, and renders runtime identity after content. Add a fallback assertion proving a view without `liveStatus` still contains `当前工作`.

- [x] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run tests/run-card.test.ts`

Expected: the new ordering, de-duplication, preview, or footer assertions fail against the existing renderer.

- [x] **Step 3: Implement the presentation-only refinement**

In `renderProjectEntryCard`, render the live-work section before secondary information, render `projectWorkSummary` only without `liveStatus`, filter plan-shaped step events from the recent activity timeline when those steps are already present in `liveStatus.planSteps`, replace the 2,000-character middle preview with a four-line tail preview, and append a compact `runtimeFooter` as the last body element.

Refactor `renderLiveStatus` so status and plans share one expanded `collapsible_panel`. Keep a nested collapsed plan panel only when the plan exceeds six steps. Preserve phase-derived border colors and all marker semantics.

- [x] **Step 4: Run focused tests**

Run: `npx vitest run tests/run-card.test.ts tests/topic-view.test.ts`

Expected: both files pass and Answer Card assertions remain unchanged.

### Task 2: Verify, deploy, and commit the feature set

**Files:**
- Modify: `docs/superpowers/plans/2026-08-27-main-card-visual-hierarchy.md` only for checkbox completion.
- Verify: all currently modified source, test, architecture, and plan files.

**Interfaces:**
- Consumes: the complete structured-observation feature and Task 1 renderer.
- Produces: a verified build deployed through the Herdr plugin and a single remaining feature commit.

- [x] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Expected: 70 test files and 711 or more tests pass; typecheck, build, and whitespace validation exit successfully.

- [x] **Step 2: Restart through the supported operator surface**

Run: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

Expected: the restart plugin log succeeds and reports the newly generated build identity.

- [x] **Step 3: Verify live readiness**

Read `/ready` and `/status` using the configured loopback host and port. Confirm readiness is `ready`, observed identity matches `dist/build-info.json`, Lark and Herdr are usable, SQLite integrity is healthy, and pending outbox converges to zero.

- [ ] **Step 4: Commit the remaining feature changes**

Stage only the structured observation, Main/Answer Card rendering, terminal fallback warning, tests, architecture, and implementation-plan files. Inspect `git diff --cached --check` and `git diff --cached --stat`, then commit with a feature-focused message. Do not push.
