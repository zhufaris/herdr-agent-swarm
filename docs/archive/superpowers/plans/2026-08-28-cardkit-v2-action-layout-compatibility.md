# CardKit 2.0 Action Layout Compatibility Implementation Plan

> **For agentic workers:** Execute this plan inline and preserve unrelated worktree changes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Lark `400 / 230099` failures by removing legacy action containers from CardKit 2.0 cards while retaining all state-driven controls.

**Architecture:** Card renderers remain pure functions. Callback buttons become direct `body.elements` entries, while form-contained buttons remain nested under their form. A recursive structural test locks down the CardKit 2.0 contract at the rendering boundary.

**Tech Stack:** TypeScript, Vitest, Lark CardKit JSON 2.0

**Spec:** `docs/superpowers/specs/2026-08-28-cardkit-v2-action-layout-compatibility-design.md`

## Global Constraints

- Preserve button labels, callback values, authorization, and phase visibility.
- Do not change provisioning checkpoints, outbox ordering, or dead-letter policy.
- Do not stage or rewrite unrelated worktree changes.

---

### Task 1: Replace legacy action containers and verify recovery-safe rendering

**Files:**
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/interaction-card.ts`
- Test: `tests/run-card.test.ts`
- Test: `tests/card-interaction-integration.test.ts`

**Interfaces:**
- Consumes: `renderProjectEntryCard(TopicViewState)` and `renderMoreActionsCard(...)`
- Produces: CardKit 2.0 JSON with callback buttons directly in `body.elements` and no `tag: "action"` nodes

- [ ] **Step 1: Write failing structural tests**

Add a recursive helper that finds nodes by `tag`. Assert that ready/running Main Cards and the More Actions response contain their expected callback buttons but contain zero `action` nodes.

- [ ] **Step 2: Run tests and observe the exact regression**

Run: `npx vitest run tests/run-card.test.ts tests/card-interaction-integration.test.ts`

Expected: FAIL because the rendered cards still contain `tag: "action"`.

- [ ] **Step 3: Apply the minimal renderer change**

In `renderProjectEntryCard`, append `...mainCardActions(input)` directly to `elements`. In `renderMoreActionsCard`, spread `actions` directly into `body.elements`. Leave form renderers unchanged.

- [ ] **Step 4: Run focused and recovery tests**

Run: `npx vitest run tests/run-card.test.ts tests/card-interaction-integration.test.ts tests/project-selection-integration.test.ts tests/provisioning-recovery.test.ts`

Expected: all tests pass, including the durable `runtime_started` recovery coverage.

- [ ] **Step 5: Run repository verification**

Run: `npm run typecheck && npm test && npm run build && git diff --check`

Expected: exit code 0 for every command.

- [ ] **Step 6: Commit only the compatibility fix**

Stage the two renderer files, two focused test files, and this plan. Confirm `git diff --cached --stat` excludes pre-existing provisioning/outbox work, then commit with the repository co-author trailer.

- [ ] **Step 7: Deploy and verify the durable checkpoint**

Restart with `herdr plugin action invoke restart --plugin herdr-lark-bridge`. Query SQLite and Herdr to verify selection `<selection-id>` is completed, Binding `<binding-id>` is active on existing Pane `wH:p3N`, and no second Pane was created.
