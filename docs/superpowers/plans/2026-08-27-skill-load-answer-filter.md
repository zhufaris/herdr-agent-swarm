# Skill Load Answer Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace typed-transcript skill file reads and their output with concise `已加载技能：<name>` lines in Answer Cards.

**Architecture:** Detect trusted absolute `SKILL.md` paths in parsed function-call argument values, attach a render policy to the existing `call_id` entry, and suppress only the paired output for recognized skill loads. Keep all filtering in `src/runtime/traex-transcript.ts`; downstream answer persistence, pagination, and CardKit rendering remain unchanged.

**Tech Stack:** TypeScript, Node.js ESM, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-skill-load-answer-filter-design.md`

## Global Constraints

- Render one `已加载技能：<name>` line per distinct recognized skill path, in argument traversal order.
- Recognize only absolute `/data00/home/<user>/.trae/skills/`, `/data00/home/<user>/.agents/skills/`, and `/data00/home/<user>/.trae/plugins/` paths ending in `/SKILL.md`.
- Suppress only the output paired by the recognized call's non-empty `call_id`.
- Preserve existing rendering for ordinary calls, results, assistant prose, malformed arguments, and relative paths.
- Do not change transcript files, cursor offsets, answer storage, pagination, or outbox behavior.

---

### Task 1: Recognize skill-load calls without false positives

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Consumes: parsed function-call argument values from `parseArguments(value: string): unknown`.
- Produces: `skillNamesFromArguments(value: unknown): string[]`, preserving first-seen order and removing duplicates.

- [ ] **Step 1: Write failing recognition tests.**

  Add transcript calls covering a direct `{ path: "/data00/home/user/.agents/skills/test/SKILL.md" }`, a real nested `exec` argument whose `input` contains two absolute skill paths, and duplicate paths. Assert summaries are exactly `已加载技能：test` and one line per distinct name.

- [ ] **Step 2: Write failing false-positive tests.**

  Add calls containing `docs/SKILL.md`, `/tmp/demo/SKILL.md`, and ordinary assistant prose mentioning `SKILL.md`. Assert generic tool rendering and assistant output remain visible.

- [ ] **Step 3: Run the focused red test.**

  Run: `npx vitest run tests/traex-transcript.test.ts -t 'skill load'`

  Expected: fail because recognized calls still expose their serialized arguments.

- [ ] **Step 4: Implement bounded argument traversal and path recognition.**

  Recursively visit strings, array entries, and object values from parsed arguments. Extract absolute path tokens ending in `/SKILL.md`, accept only the three trusted root patterns, derive the parent directory basename, and deduplicate names in encounter order. Do not scan tool output.

- [ ] **Step 5: Run the focused recognition tests.**

  Run: `npx vitest run tests/traex-transcript.test.ts -t 'skill load'`

  Expected: recognized summaries pass and all false-positive cases keep their original content.

### Task 2: Suppress only the paired skill document output

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Changes the existing `callsById` value from `{ name: string }` to `{ name: string; suppressOutput: boolean }`.
- `renderItem(item: unknown): string` emits the summary at call time and returns an empty string for only the paired suppressed result.

- [ ] **Step 1: Write failing call/result pairing tests.**

  Append a recognized skill call followed in a later mutation by a large `function_call_output` containing the skill frontmatter/body. Assert the summary appears once and the body never appears. In the same test, append a normal call/result whose output includes the literal `SKILL.md` and assert that output remains visible.

- [ ] **Step 2: Run the focused pairing test.**

  Run: `npx vitest run tests/traex-transcript.test.ts -t 'paired skill'`

  Expected: fail because the paired skill result is currently rendered as an execution-result fence.

- [ ] **Step 3: Store and enforce the per-call render policy.**

  When a function call is accepted, compute skill names, store `suppressOutput: skillNames.length > 0`, and return joined summary lines for skill loads. On a matched result, mark its item ID emitted and return an empty string when `suppressOutput` is true; otherwise retain `renderFunctionOutput` and existing diff/text fencing.

- [ ] **Step 4: Verify transcript and prompt integration.**

  Run: `npx vitest run tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts tests/pane-thread-lifecycle-integration.test.ts`

  Expected: all typed transcript, turn streaming, and detached recovery tests pass.

### Task 3: Document, verify, commit, and deploy

**Files:**
- Modify: `docs/architecture.md`
- Include: `docs/superpowers/plans/2026-08-27-skill-load-answer-filter.md`

**Interfaces:**
- Documents the typed transcript projection boundary; no runtime interface changes.

- [ ] **Step 1: Document the projection rule.**

  In the typed transcript section, state that trusted skill-file reads become concise load summaries and their paired outputs are excluded before durable answer projection. State that ordinary tool output is unchanged.

- [ ] **Step 2: Run the release gate.**

  Run: `npm run typecheck`

  Run: `npm run build`

  Run: `npm test`

  Run: `git diff --check`

  Expected: every command exits 0.

- [ ] **Step 3: Commit the implementation slice.**

  Stage only `src/runtime/traex-transcript.ts`, `tests/traex-transcript.test.ts`, `docs/architecture.md`, and this plan. Commit with `fix: summarize skill loads in Answer Cards`.

- [ ] **Step 4: Rebuild and deploy through the supported plugin action.**

  Run `npm run build`, then `herdr plugin action invoke restart --plugin herdr-lark-bridge`. Do not use direct `systemctl restart`, because the plugin action refreshes `BRIDGE_EXPECTED_BUILD_ID`.

- [ ] **Step 5: Verify live convergence.**

  Poll `http://127.0.0.1:8787/status` until `identity.gitCommit` matches the new commit, `identity.buildId` matches `dist/build-info.json`, `readiness.status` is `ready`, `startupRecovery.state` is `completed`, and `operational.pendingOutbox` is zero.
