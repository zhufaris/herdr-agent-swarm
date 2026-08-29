# Exact Composer Prompt Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent short prompts and stale composer text from causing false prompt confirmation, duplicate text, or `Timed out waiting for prompt text` failures.

**Architecture:** Keep prompt delivery inside `HerdrCliAdapter`, but replace whole-screen occurrence counting with a pure parser for the active bottom TraeX composer. `submitPromptText` classifies the composer before mutation, preserves unrelated drafts, reuses an exact unsubmitted prompt, and confirms new text only by exact composer equality.

**Tech Stack:** TypeScript, Node.js, Herdr CLI/native adapter, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-exact-composer-prompt-confirmation-design.md`

## Global Constraints

- Never overwrite a non-empty composer containing text different from the requested prompt.
- Invoke `onDispatched` only when Enter is sent or native Agent dispatch may already have reached TraeX.
- Never automatically replay a prompt after it may have reached TraeX.
- Terminal text remains control-plane evidence and never becomes Answer content.

---

### Task 1: Lock down active-composer parsing and dispatch behavior

**Files:**
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `src/adapters/herdr-adapter.ts`

**Interfaces:**
- Consumes: `HerdrCliAdapter.runPrompt(...)`, `HerdrCliAdapter.steerPrompt(...)`, and bounded `pane read` output.
- Produces: private `activeTraexComposer(output: string): string | null` parsing and exact composer confirmation inside `submitPromptText(...)`.

- [ ] **Step 1: Write failing adapter regressions**

Add public-seam tests proving that unrelated `shift` text cannot confirm `hi`, an existing exact `hi` sends Enter without another `send-text`, a different draft throws `composer_not_empty`, and soft-wrapped exact text still confirms.

- [ ] **Step 2: Run the focused tests and verify the new cases fail**

Run: `npx vitest run tests/herdr-adapter.test.ts`

Expected: the new cases fail against whole-screen `countOccurrences` behavior.

- [ ] **Step 3: Implement the minimal active-composer parser**

Parse the final composer marker and its continuation lines from stripped terminal output. Ignore separators and the bottom status line. Normalize composer markers and whitespace only after isolating that region.

- [ ] **Step 4: Implement the four-state submit flow**

Before `send-text`, classify the active composer as empty, exact, different, or unavailable. Send Enter directly for exact text; reject different text with `composer_not_empty`; otherwise send text and wait for exact active-composer equality before Enter. Remove whole-screen occurrence counting.

- [ ] **Step 5: Run focused tests until green**

Run: `npx vitest run tests/herdr-adapter.test.ts`

Expected: all Herdr adapter tests pass, including the new short-prompt and stale-composer cases.

### Task 2: Verify, commit, and deploy

**Files:**
- Verify: all modified source, tests, spec, and plan files

**Interfaces:**
- Consumes: the completed adapter behavior from Task 1.
- Produces: a tested commit and deployed plugin build.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit zero.

- [ ] **Step 2: Scan for obsolete confirmation logic and formatting errors**

Run: `rg -n "countOccurrences\(|previousOccurrences" src/adapters/herdr-adapter.ts tests/herdr-adapter.test.ts`

Expected: no obsolete whole-screen prompt confirmation remains.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/adapters/herdr-adapter.ts tests/herdr-adapter.test.ts docs/superpowers/plans/2026-08-29-exact-composer-prompt-confirmation.md
git commit -m "fix: confirm prompts against active composer"
```

- [ ] **Step 4: Inspect live work before restart**

Read `/status` and verify queued prompts, running prompts, active workers, instance turns, and pending outbox. Use the lifecycle force path only when remaining running rows are detached or stale and shutdown preserves no-replay semantics.

- [ ] **Step 5: Build the committed revision and restart through the plugin lifecycle**

Run: `npm run build`

Run normally: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

If the supported action cannot express a justified force restart, run: `bash plugin/service.sh restart --force`

- [ ] **Step 6: Verify deployment convergence**

Read `/status` and require `status=ok`, `readiness=ready`, the deployed `gitCommit` equal to the implementation commit, zero active workers/instance turns, and a drained outbox. Confirm `wH:p5Z` is not mutated during verification.
