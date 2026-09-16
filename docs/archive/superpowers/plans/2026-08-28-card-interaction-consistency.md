# Card Interaction Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale Main Cards from advertising unusable steering and restrict orphaned bindings to recovery-safe actions.

**Architecture:** Keep TopicView as the durable presentation model, but require its `activePromptId` capability before rendering supplement controls. Keep `CardInteractionWorkflow` as the final active-turn fence and make More Actions derive controls from attachment before lifecycle so orphaned bindings never advertise pane-dependent commands.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, CardKit 2.0, SQLite

**Spec:** `docs/superpowers/specs/2026-08-28-card-interaction-consistency-design.md`

## Global Constraints

- Never convert rejected steering into an ordinary prompt.
- Never replay text after steering may have reached TraeX.
- Preserve binding generation, creator authorization, interaction expiry, and callback idempotency checks.
- Preserve direct CardKit 2.0 callback buttons under `body.elements`.
- Preserve the four-character random `task-xxxx` tab naming policy.
- Do not rewrite live SQLite history or delete outbox, interaction, or audit records.

---

### Task 1: Capability-aware Main Card controls

**Files:**
- Modify: `tests/run-card.test.ts`
- Modify: `src/cards/run-card.ts`

**Interfaces:**
- Consumes: `TopicViewState.activePromptId: string | null`, `TopicViewState.phase`
- Produces: `mainCardActions(input: TopicViewState): object[]` with `open_supplement` only for an active prompt in `running` or `blocked`

- [ ] **Step 1: Write failing renderer tests**

Add cases asserting that `running` and `blocked` views with `activePromptId: null` omit `open_supplement`, while the same phases with `activePromptId: "p1"` retain it. Assert recovery and More Actions remain available for the stale blocked view.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run tests/run-card.test.ts`

Expected: the stale running/blocked cases still contain `open_supplement`.

- [ ] **Step 3: Gate the button on active prompt identity**

In `mainCardActions`, add `const canSupplement = input.activePromptId !== null && (input.phase === "running" || input.phase === "blocked");`. Use it to construct actions without changing callback payload format, queue controls, or recovery controls.

- [ ] **Step 4: Run the focused renderer test**

Run: `npx vitest run tests/run-card.test.ts`

Expected: PASS.

### Task 2: Runtime-fenced supplement feedback and orphan action set

**Files:**
- Modify: `tests/card-interaction-integration.test.ts`
- Modify: `tests/run-card.test.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/cards/interaction-card.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`

**Interfaces:**
- Consumes: `activeTurn(bindingId): { promptId: string; paneId: string } | null` and the existing `Binding.attachment`, `Binding.lifecycle`, and creator identity
- Produces: precise stale-supplement warnings and `renderMoreActionsCard(...)` with recovery-safe orphan controls
- Produces: a fresh runtime gate before queued ordinary work is irreversibly converted to steering

- [ ] **Step 1: Write failing interaction tests**

Add assertions that a supplement submitted after the captured turn ends returns `任务刚刚结束，补充内容未发送。` and never calls `paneControl.steer`. Add a queued-prompt conversion case where fresh runtime observation is no longer steerable and prove the prompt remains an ordinary FIFO turn. Add an orphaned creator case that includes refresh, reattach, replace, and archive, while excluding stop, model, reset, and pane close. Add a non-creator orphan case that exposes refresh only.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `npx vitest run tests/card-interaction-integration.test.ts tests/run-card.test.ts`

Expected: stale supplement copy and orphan control-set assertions fail.

- [ ] **Step 3: Implement the minimal behavior**

Update stale supplement warnings in `CardInteractionWorkflow` without enqueueing a prompt. Before `convertQueuedPromptToSteering`, observe the active pane and accept only `working` or `blocked`; on a terminal state or observation error, preserve the ordinary queued prompt. Wire this read-only capability from the existing Herdr port in production and test composition roots. In `renderMoreActionsCard`, branch on `attachment === "orphaned"` before adding lifecycle-active actions; add archive alongside reattach and replace for creator-owned orphaned bindings. Keep callback data in `behaviors[].value`.

- [ ] **Step 4: Run focused interaction tests**

Run: `npx vitest run tests/card-interaction-integration.test.ts tests/run-card.test.ts tests/lark-adapter.test.ts`

Expected: PASS.

### Task 3: Repository and live-service verification

**Files:**
- Verify only: source, tests, generated `dist/`, managed service

**Interfaces:**
- Consumes: repository build scripts and plugin-managed systemd lifecycle
- Produces: a tested build with matching runtime build identity and converged live cards

- [ ] **Step 1: Run static and full behavioral verification**

Run: `npm run typecheck`

Run: `npm test`

Expected: both PASS.

- [ ] **Step 2: Build the production artifact**

Run: `npm run build`

Expected: TypeScript build and build-identity generation succeed.

- [ ] **Step 3: Commit only this fix and its plan**

Stage only `docs/superpowers/plans/2026-08-28-card-interaction-consistency.md`, `src/cards/run-card.ts`, `src/cards/interaction-card.ts`, `src/coordinator/card-interaction-workflow.ts`, `tests/run-card.test.ts`, and `tests/card-interaction-integration.test.ts`. Preserve unrelated architecture-document work.

- [ ] **Step 4: Restart and verify the managed bridge**

Run: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

Then inspect `/health`, `/ready`, `/status`, expected versus observed build identity, and SQLite projections for `<binding-id>`. Confirm no TraeX prompt was replayed and no historical state was deleted.
