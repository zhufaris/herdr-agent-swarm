# Disable Terminal Answer Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every path that turns Herdr terminal text into Answer Card content while preserving terminal-based lifecycle observation and prompt replay safety.

**Architecture:** `PromptRunWorkflow` will model output as either a validated typed transcript or an unavailable structured source. Live observations continue to carry Herdr state but emit Answer content only from typed JSONL. Because the current schema does not durably prove Answer provenance across restart, detached recovery completes with one fixed safe notice, never from terminal snapshots or legacy RunCard text.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, SQLite, Pino, Herdr, TraeX JSONL

**Spec:** `docs/superpowers/specs/2026-08-29-disable-terminal-answer-fallback-design.md`

## Global Constraints

- Do not add a configuration switch or retain a dormant compatibility path.
- Terminal reads remain available for control-plane state observation only.
- A missing or failed typed transcript must never fail or replay a dispatched prompt.
- The only no-typed-output Answer is `⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。`
- Preserve SQLite transaction, outbox, CardKit pagination, and frozen-page behavior.

---

### Task 1: Lock down live-turn structured-output-only behavior

**Files:**
- Modify: `tests/concurrency-controls.integration.test.ts`
- Modify: `tests/steering-integration.test.ts`

**Interfaces:**
- Consumes: existing `PromptRunWorkflow`, `TraexTranscriptReaderPort`, and RunCard projections.
- Produces: regression expectations for the fixed `STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE` behavior and the absence of terminal-derived Answer deltas.

- [ ] **Step 1: Replace terminal fallback expectations with unavailable-output expectations**

Define the test-local expected notice:

```ts
const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE =
  "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";
```

Update the missing-identity test so `readOutput()` returns a unique sentinel such
as `SECRET_TERMINAL_SENTINEL`, then assert the completed RunCard equals only the
fixed notice and does not contain the sentinel. Keep the `turn-started`
`fallbackReason: "missing_session_identity"` assertion.

- [ ] **Step 2: Cover transcript read failure before typed output**

Make `cursor.readDelta()` throw on its first read while Herdr observations contain
`SECRET_TRANSCRIPT_FAILURE_TERMINAL`. Assert the final Answer equals the fixed
notice, excludes the sentinel, and the log record is:

```ts
expect(records).toContainEqual(expect.objectContaining({
  event: "traex-transcript-read-failed",
  fallbackReason: "transcript_read_failed",
  outcome: "structured_output_unavailable"
}));
```

- [ ] **Step 3: Preserve typed output after a later transcript failure**

Keep the existing test in which one typed delta succeeds and a later read throws.
Assert the Answer remains exactly the accumulated typed content, excludes the
terminal sentinel, and logs `outcome: "typed_output_preserved"`.

- [ ] **Step 4: Remove obsolete redraw and warning-card tests**

Delete tests whose contract is specifically terminal Answer warning insertion,
terminal redraw replacement, or warning de-duplication. Update ordinary queue and
steering tests that do not provide a transcript reader to expect the fixed notice
instead of terminal text.

- [ ] **Step 5: Run the focused tests and confirm the new assertions fail**

Run:

```bash
npx vitest run tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts
```

Expected: failures show terminal-derived content or old fallback log outcomes,
proving the regression tests reach the live fallback path.

### Task 2: Delete live terminal Answer production

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/steering-integration.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReaderPort.open()` and `TraexTranscriptCursorPort.readObservation()`.
- Produces: `TurnOutputSource = { mode: "unavailable"; reason: string } | { mode: "typed"; cursor; emitted; chunks }`.

- [ ] **Step 1: Replace terminal source state with unavailable source state**

Use this source shape and fixed notice:

```ts
type TurnOutputSource =
  | { mode: "unavailable"; reason: string }
  | { mode: "typed"; cursor: TraexTranscriptCursorPort; emitted: boolean; chunks: string[] };

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE =
  "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";
```

Map every non-typed transcript open result to `mode: "unavailable"` while
retaining its bounded reason. Keep the first-turn identity grace loop keyed from
the unavailable reason.

- [ ] **Step 2: Remove terminal Answer parsing from live observations**

Delete `previousObservation`, `parseTerminalStreamDelta`,
`terminalFallbackSnapshot`, and `warningPublished`. During `runPrompt` callbacks,
publish Answer deltas only when `readTypedDelta()` returns typed content. Continue
publishing typed `mainStatus`; do not derive Answer, model, or context fields from
terminal output.

- [ ] **Step 3: Remove terminal final extraction**

Delete `extractFinalTraexAnswer`, the final `readOutput()` used for Answer
extraction, the RunCard terminal accumulation lookup,
`TERMINAL_FALLBACK_WARNING`, and `withTerminalFallbackWarning()`. Finalize with:

```ts
const sourceAnswer = outputSource.mode === "typed"
  ? outputSource.chunks.join("\n\n")
  : "";
const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
```

Fingerprint only `sourceAnswer`, preserving the distinction between source output
and the synthetic notice.

- [ ] **Step 4: Make transcript read failure terminal-free**

When the first typed read fails, return `{ mode: "unavailable", reason:
"transcript_read_failed" }` and log `structured_output_unavailable`. When typed
content was already emitted, keep the typed source and log
`typed_output_preserved`. Do not inspect terminal output in either branch.

- [ ] **Step 5: Run focused tests until green**

Run:

```bash
npx vitest run tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts
```

Expected: both files pass and every sentinel remains absent from Answer content.

- [ ] **Step 6: Commit the live-path deletion**

```bash
git add src/coordinator/prompt-run-workflow.ts tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts
git commit -m "refactor: remove terminal answer fallback"
```

### Task 3: Remove terminal content from detached recovery

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `tests/prompt-run-safety-scan.test.ts`
- Modify: `tests/pane-thread-lifecycle-integration.test.ts`

**Interfaces:**
- Consumes: Herdr process/state observation and `STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE`.
- Produces: detached completion that always uses the fixed notice because persisted RunCard Answer provenance is not currently durable.

- [ ] **Step 1: Add a detached recovery regression test**

In `tests/pane-thread-lifecycle-integration.test.ts`, create a running detached prompt whose Herdr terminal contains
`SECRET_DETACHED_TERMINAL_SENTINEL`. Wake its detached observer, transition the
fake pane to completed, and assert the completed Answer excludes both the sentinel
and any legacy terminal warning. Seed the RunCard with
`LEGACY_UNPROVEN_ANSWER_SENTINEL` and assert the recovered Answer is exactly the
fixed notice. Also assert the prompt was not submitted again.

- [ ] **Step 2: Run the detached test and confirm it fails**

Run:

```bash
npx vitest run tests/pane-thread-lifecycle-integration.test.ts -t "completes a detached turn without terminal Answer content"
```

Expected: the current
observer completes with terminal-derived text or a previously accumulated terminal
RunCard Answer.

- [ ] **Step 3: Delete detached terminal Answer extraction**

Keep terminal reads only when `agentState === "unknown"` and they are required
to decide lifecycle completion. Never pass their content to `completeTurn()`. Do
not reuse an existing RunCard Answer because the current schema cannot prove that
it came from typed JSONL. Complete with
`STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE`.

- [ ] **Step 4: Run detached and safety-scan tests until green**

Run:

```bash
npx vitest run tests/prompt-run-safety-scan.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/concurrency-controls.integration.test.ts
```

Expected: detached recovery completes without replay and without terminal Answer
content.

- [ ] **Step 5: Commit detached recovery hardening**

```bash
git add src/coordinator/prompt-run-workflow.ts tests/prompt-run-safety-scan.test.ts tests/pane-thread-lifecycle-integration.test.ts
git commit -m "fix: keep detached answers terminal-free"
```

### Task 4: Align architecture and verify complete removal

**Files:**
- Modify: `docs/architecture.md`
- Modify: affected tests found by the source scan

**Interfaces:**
- Consumes: the structured-only runtime contract implemented in Tasks 2 and 3.
- Produces: current architecture documentation and repository-wide verification evidence.

- [ ] **Step 1: Rewrite the Answer source section**

Replace terminal-mode and fallback language with the two-state contract: validated
typed output or structured output unavailable. State explicitly that terminal
snapshots remain control-plane observations and never become Answer content,
including after restart.

- [ ] **Step 2: Remove stale fallback expectations and helpers**

Run:

```bash
rg -n "TERMINAL_FALLBACK_WARNING|terminalFallbackSnapshot|withTerminalFallbackWarning|terminal fallback|pane fallback" src tests docs/architecture.md
```

Expected: no runtime/test references remain; documentation may mention only that
the removed behavior is forbidden. Delete or rewrite every stale test expectation.

- [ ] **Step 3: Run focused validation**

```bash
npx vitest run tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts tests/prompt-run-safety-scan.test.ts
npm run typecheck
```

Expected: all focused tests and TypeScript checks pass.

- [ ] **Step 4: Run repository validation**

```bash
npm test
npm run build
```

Expected: the complete Vitest suite and production build pass.

- [ ] **Step 5: Commit documentation and residual test cleanup**

```bash
git add docs/architecture.md tests
git commit -m "docs: make typed transcripts the only answer source"
```

### Task 5: Deploy safely and verify runtime policy

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: plugin restart action, `/status`, SQLite operational state, and live Herdr/Lark integration.
- Produces: a ready service running the committed structured-only Answer build.

- [ ] **Step 1: Check deployment gates**

Inspect `/status` and SQLite. Require zero queued/running prompts, zero active turn
and steering workers, and zero pending outbox rows before restart. Do not replay or
cancel uncertain work to satisfy the gate.

- [ ] **Step 2: Rebuild and restart**

```bash
npm run build
herdr plugin action invoke restart --plugin herdr-lark-bridge
```

Use the installed plugin name reported by `herdr plugin list` if it differs.

- [ ] **Step 3: Verify readiness and build identity**

Check `herdr plugin action invoke status --plugin herdr-lark-bridge` and
`http://127.0.0.1:8788/status`. Require `ready`, the new Git commit, the generated
build identity, Lark connected, no active workers, and no pending outbox work.

- [ ] **Step 4: Verify both output cases without replay**

On a fresh/reset topic with a valid reported TraeX identity, send one controlled
prompt and verify structured JSONL output appears. On a controlled topic lacking
identity, verify the Answer contains only the fixed notice and no terminal chrome.
Do not reuse or resubmit an uncertain prompt.
