# CardKit 2.0 Callback Behavior Implementation Plan

> **For agentic workers:** Execute this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every direct CardKit 2.0 button emit its existing callback so the Main Card controls and their follow-up actions work again.

**Architecture:** A shared pure renderer constructs CardKit 2.0 callback buttons with `behaviors[].value`. Existing card renderers supply their current labels, types, and opaque payloads; callback normalization and workflows remain unchanged.

**Tech Stack:** TypeScript, Vitest, Lark CardKit JSON 2.0

**Spec:** `docs/superpowers/specs/2026-08-28-cardkit-v2-callback-behavior-design.md`

## Global Constraints

- Preserve all existing labels, phase visibility, payload fields, authorization, and idempotency.
- Keep buttons directly in CardKit 2.0 element lists; never restore `tag: "action"`.
- Render form submits with CardKit 2.0 `form_action_type` plus callback behavior.
- Preserve unrelated worktree changes.

---

### Task 1: Enforce the CardKit 2.0 callback-button contract

**Files:**
- Create: `src/cards/cardkit-button.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/interaction-card.ts`
- Modify: `src/cards/operations-card.ts`
- Modify: `src/cards/space-directory-card.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: button label, callback payload, and optional visual type
- Produces: `callbackButton(content, value, type?)` returning a CardKit 2.0 button with one callback behavior

- [ ] **Step 1: Add a failing renderer regression test**

Assert that a running Main Card with queued work renders `open_supplement`,
`view_queue`, and `open_more_actions` under `behaviors[0].value`, with no
top-level `value`. Assert the More Actions card follows the same contract.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run tests/run-card.test.ts`

Expected: fail because current direct buttons expose only top-level `value`.

- [ ] **Step 3: Add the shared helper and migrate direct buttons**

Implement `callbackButton(content: string, value: object, type?: "primary" |
"default" | "danger")` and replace direct callback-button literals/helpers
in the four card renderer modules.

- [ ] **Step 4: Run focused interaction tests**

Run: `npx vitest run tests/run-card.test.ts tests/card-interaction-integration.test.ts tests/lark-adapter.test.ts`

Expected: all tests pass and the callback payload remains normalized as
`action.value`.

- [ ] **Step 5: Verify the repository**

Run: `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

Expected: every command exits with status 0.

### Task 2: Preserve the running Main Card across steering completion

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/startup-view-converger.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/startup-view-converger.test.ts`

**Interfaces:**
- Consumes: prompt `dispatchKind`, RunCard phase, and durable TopicView active prompt
- Produces: a Main Card that remains `running` and blue until the parent turn ends

- [ ] **Step 1: Add store and startup recovery regression tests**

Assert that completing a steering prompt updates only its Answer Card, and that
startup convergence selects a running parent ahead of a newer completed
steering card.

- [ ] **Step 2: Run both tests and observe the exact `running -> done` failure**

Run: `npx vitest run tests/sqlite-store.test.ts tests/startup-view-converger.test.ts`

- [ ] **Step 3: Stop steering terminal persistence from mirroring to TopicView**

Inspect the prompt dispatch kind in `persistTerminalRunCard`; return after saving
the steering RunCard and before mirroring it to the shared TopicView.

- [ ] **Step 4: Prefer an active RunCard during startup convergence**

Choose a `running` or `blocked` RunCard before falling back to the most recently
created RunCard.

- [ ] **Step 5: Re-run focused and repository verification**

Run the focused tests from Task 1 plus `tests/sqlite-store.test.ts` and
`tests/startup-view-converger.test.ts`, followed by the full verification suite.
