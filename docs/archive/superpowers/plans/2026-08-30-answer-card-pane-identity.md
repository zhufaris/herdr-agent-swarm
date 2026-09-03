# Answer Card Pane Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the durable Herdr session/pane title on every Answer Card without changing the card-root thread topology.

**Architecture:** Persist the existing binding title as optional `RunCardView.sessionTitle` presentation metadata. Populate it at prompt creation and conversion, repair legacy views during startup convergence, and render one bounded subtitle with a deterministic pane-ID fallback.

**Tech Stack:** TypeScript ESM, Vitest, SQLite JSON projections, Lark CardKit 2.0

**Spec:** `docs/superpowers/specs/2026-08-30-answer-card-pane-identity-design.md`

## Global Constraints

- Keep the interactive card as the Lark thread root; `[Card Message]` remains client-owned.
- Answer Card subtitle is `<space> / <pane name> · <request title>`.
- Fall back to `<space> / <paneId>` only when the durable session title is absent.
- Existing databases must gain a nullable `session_title` column through the idempotent startup migration path.
- Do not change prompt dispatch, answer offsets, stream sequencing, or frozen Answer Card pages.
- Do not force restart the service without a new explicit authorization.

---

### Task 1: Durable Run Card session identity and rendering

**Files:**
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/run-card.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: optional `RunCardView.sessionTitle?: string` and matching `createQueuedRunCard()` input.
- Produces: Answer Card subtitle formatting that consumes `sessionTitle`, `spaceName`, `paneId`, and request `title`.

- [ ] **Step 1: Write failing rendering tests**

Add assertions proving a streaming card, completed card, and page 7 card render `datasage / task-7kq2 · <request title>`. Add a legacy-view case with no `sessionTitle` that renders `datasage / w5:p3G · <request title>`. Keep the Request Card assertion unchanged.

- [ ] **Step 2: Run the rendering tests and verify failure**

Run: `npx vitest run tests/run-card.test.ts`
Expected: FAIL because Answer Card subtitles contain only the request title.

- [ ] **Step 3: Add the optional durable field and subtitle helper**

Extend the interface and constructor input with `sessionTitle?: string`; initialize it from the input. Add nullable `session_title` persistence, startup column creation, and JSON-view projection in `SqliteBindingStore`. Add a pure helper equivalent to:

```ts
function answerCardSubtitle(input: RunCardView): string {
  const identity = input.sessionTitle?.trim()
    || [input.spaceName, input.paneId].filter(Boolean).join(" / ")
    || "unknown";
  return boundedTitle(`${identity} · ${input.title}`);
}
```

Use it in `renderRequestAnswerCard()` and `renderFinalAnswerCard()` so streaming and frozen completion cards agree while Request Cards and root cards retain their existing copy.

- [ ] **Step 4: Run the rendering tests and verify pass**

Run: `npx vitest run tests/run-card.test.ts tests/sqlite-store.test.ts`
Expected: PASS.

### Task 2: Capture and preserve binding titles

**Files:**
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/card-interaction-integration.test.ts`

**Interfaces:**
- Consumes: `createQueuedRunCard({ sessionTitle?: string })` from Task 1.
- Produces: every newly accepted ordinary/steering Run Card records `binding.title`; rejected steering conversion records the current binding title.

- [ ] **Step 1: Write failing coordinator tests**

Assert that an ordinary/automatic steering acceptance stores `sessionTitle` equal to the binding title. In the failed automatic steering conversion test, assert the replacement Run Card has the binding title even when the source legacy view lacks it.

- [ ] **Step 2: Run the focused coordinator tests and verify failure**

Run: `npx vitest run tests/concurrency-controls.integration.test.ts tests/card-interaction-integration.test.ts`
Expected: FAIL because the new field is absent.

- [ ] **Step 3: Populate the field at both creation boundaries**

Add `sessionTitle: binding.title` to the shared inbound creation input and to `enqueueFailedSteering()` when it creates the replacement ordinary turn. Do not copy a stale source title over the current binding title.

- [ ] **Step 4: Run focused coordinator tests and verify pass**

Run the same Vitest files from Step 2.
Expected: PASS.

### Task 3: Backfill legacy projections during startup

**Files:**
- Modify: `src/coordinator/startup-view-converger.ts`
- Test: `tests/startup-view-converger.test.ts`

**Interfaces:**
- Consumes: optional `RunCardView.sessionTitle` from Task 1.
- Produces: persisted legacy/current Run Cards converge to the authoritative `binding.title` with one view-version increment.

- [ ] **Step 1: Write a failing legacy convergence test**

Persist a Run Card without `sessionTitle`, converge a binding titled `herdr-lark-bridge / task-ab12`, and assert the saved view has that title, the expected incremented `viewVersion`, and an Answer Card update using the new subtitle when the card already exists.

- [ ] **Step 2: Run the startup test and verify failure**

Run: `npx vitest run tests/startup-view-converger.test.ts`
Expected: FAIL because startup convergence repairs only `spaceName`.

- [ ] **Step 3: Reconcile both presentation fields atomically**

Replace the single-field conditional with one `needsRunCardIdentityUpdate` check for `spaceName !== expectedSpaceName || sessionTitle !== binding.title`. Save one patched view with both fields, one version increment, and one timestamp. Use that current view for all subsequent Answer Card update/page convergence decisions.

- [ ] **Step 4: Run the startup test and verify pass**

Run: `npx vitest run tests/startup-view-converger.test.ts`
Expected: PASS.

### Task 4: Regression verification and implementation commit

**Files:**
- Verify all files changed in Tasks 1-3.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: one verified implementation commit; no deployment side effects.

- [ ] **Step 1: Run affected suites together**

Run: `npx vitest run tests/run-card.test.ts tests/sqlite-store.test.ts tests/startup-view-converger.test.ts tests/card-interaction-integration.test.ts tests/concurrency-controls.integration.test.ts`
Expected: all tests pass.

- [ ] **Step 2: Run static and build checks**

Run: `npm run typecheck && npm run build`
Expected: both commands exit zero and build identity is regenerated successfully.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all test files and tests pass.

- [ ] **Step 4: Review the exact diff and commit only feature files**

Run `git diff --check`, inspect `git diff --stat` and the feature diff, then stage only the source/tests/plan files from this feature. Commit with:

```text
feat: identify pane on answer cards

Co-authored-by: TRAE CLI <traecli@bytedance.com>
```

- [ ] **Step 5: Inspect deployment safety without restarting**

Use the repository's status/restart-gate command to inspect running, queued, and uncertain work. Report whether a normal restart is currently safe. Do not use `--force` unless the user explicitly authorizes it for this change.
