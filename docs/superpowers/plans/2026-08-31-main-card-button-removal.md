# Main Card Button Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Lark topic Main Card read-only by rendering no interactive buttons.

**Architecture:** Remove the Main Card renderer's state-derived action section only. Keep all other CardKit renderers and card-action workflows unchanged so prompt routing, durable delivery, and non-Main-Card administration controls retain their current contracts.

**Tech Stack:** TypeScript, Vitest, Lark CardKit 2.0.

**Spec:** `docs/superpowers/specs/2026-08-31-main-card-button-removal-design.md`

## Global Constraints

- Apply the removal to every `TopicViewState.phase`, including recovery states.
- Preserve Main Card status, notices, progress, and runtime footer.
- Do not change Action Card, Answer Card, instance, operations, prompt, outbox, SQLite, or coordinator behavior.
- Do not commit unrelated pre-existing worktree changes.

---

### Task 1: Make the Main Card renderer read-only

**Files:**
- Modify: `src/cards/run-card.ts:7,133-172`
- Test: `tests/run-card.test.ts:93-109,391-433`

**Interfaces:**
- Consumes: `renderProjectEntryCard(input: TopicViewState): object`.
- Produces: a CardKit Main Card with no `tag: "button"` nodes for any phase.

- [ ] **Step 1: Change the focused renderer test to express the new contract**

Replace the Main Card callback assertions in the CardKit renderer test with:

```ts
expect(mainButtons).toEqual([]);
```

Keep the More Actions callback assertions, proving the change is scoped to the
Main Card. Replace recovery-state and phase-matrix expected actions with empty
arrays while preserving their visible-copy assertions.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/run-card.test.ts`

Expected: failure because `renderProjectEntryCard()` still appends buttons.

- [ ] **Step 3: Remove the Main Card action rendering**

Delete `elements.push(...mainCardActions(input));`, delete the now-unused
`mainCardActions()` helper, and remove the now-unused `callbackButton` import
from `src/cards/run-card.ts`. Leave every other renderer in the file untouched.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/run-card.test.ts`

Expected: all tests in the focused file pass, proving all Main Card phases are
read-only while More Actions remains interactive.

- [ ] **Step 5: Run repository verification**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit successfully after the unused import and helper
are removed.

- [ ] **Step 6: Commit only this scoped change if requested**

```bash
git add src/cards/run-card.ts tests/run-card.test.ts docs/superpowers/specs/2026-08-31-main-card-button-removal-design.md docs/superpowers/plans/2026-08-31-main-card-button-removal.md
git commit -m "fix: remove Main Card action buttons"
```
