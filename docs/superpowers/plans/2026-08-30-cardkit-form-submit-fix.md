# CardKit Form Submit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore CardKit 2.0 form callbacks for instance creation and steering.

**Architecture:** Correct the protocol at the shared form-submit button helper, then verify the complete render-normalize-workflow path with deterministic tests. Preserve existing callback logging, authorization, persistence, and lifecycle behavior.

**Tech Stack:** TypeScript, Vitest, Lark CardKit 2.0, `@larksuiteoapi/node-sdk`

**Spec:** `docs/superpowers/specs/2026-08-30-cardkit-form-submit-fix-design.md`

## Global Constraints

- Emit only `action_type: "form_submit"`; do not retain `form_action_type`.
- Keep ordinary callback button payloads unchanged.
- Never log form values or secrets.
- Do not force-restart the service or bypass the active-work safety gate.

---

### Task 1: Correct and verify the CardKit form-submit contract

**Files:**
- Modify: `src/cards/cardkit-button.ts`
- Modify: `tests/instance-cards.test.ts`
- Modify: `tests/run-card.test.ts`
- Modify: `tests/lark-adapter.test.ts`
- Modify: `tests/instance-routing.integration.test.ts`

**Interfaces:**
- Consumes: `formSubmitButton()`, `normalizeCardActionEvent()`, and `InstanceInteractionWorkflow.handleCardAction()`.
- Produces: CardKit 2.0 form buttons with `action_type: "form_submit"` and regression evidence that a representative callback creates an instance.

- [ ] **Step 1: Change the render assertions so they require the canonical field**

Update existing form assertions to require `action_type: "form_submit"` and reject `form_action_type`. Add an integration assertion that takes a representative raw callback containing `form_value`, normalizes it, and submits it to the workflow.

- [ ] **Step 2: Run the focused tests and observe the contract failure**

Run: `npx vitest run tests/instance-cards.test.ts tests/run-card.test.ts tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts`

Expected: FAIL because the rendered submit buttons still contain `form_action_type: "submit"`.

- [ ] **Step 3: Implement the minimal protocol correction**

Change `formSubmitButton()` so its extra properties are exactly:

```ts
{ name, action_type: "form_submit" }
```

Do not change `callbackButton()` or workflow behavior.

- [ ] **Step 4: Run focused and repository-wide verification**

Run:

```bash
npx vitest run tests/instance-cards.test.ts tests/run-card.test.ts tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: every command exits `0`; no test is skipped.

- [ ] **Step 5: Commit the fix**

```bash
git add src/cards/cardkit-button.ts tests/instance-cards.test.ts tests/run-card.test.ts tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts docs/superpowers/specs/2026-08-30-cardkit-form-submit-fix-design.md docs/superpowers/plans/2026-08-30-cardkit-form-submit-fix.md
git commit -m "fix: submit CardKit forms with the v2 contract" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

- [ ] **Step 6: Gate and perform live verification**

Build first, inspect the durable status for active or uncertain work, then invoke the existing non-force plugin restart only when safe. Verify readiness and ask the operator to click `创建实例`; confirm callback logs and the resulting instance row without exposing form values.
