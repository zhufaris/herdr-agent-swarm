# TraeX Typed Transcript Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `history_mutation.payload.items` the real typed Answer Card source, expose why each turn selected typed or terminal mode, and safely leave unidentified existing panes on terminal fallback.

**Architecture:** Replace the current event-message renderer with a stateful typed-item projector owned by the transcript cursor. Change transcript opening from nullable success to a discriminated result carrying bounded fallback reasons, then make `PromptRunWorkflow` choose and log one source mode per turn. Existing panes are never matched heuristically; newly created or reset bridge-managed panes become typed after their SessionStart identity is observed.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Pino, Herdr native session identity, SQLite-backed workflow state, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-traex-typed-transcript-design.md`

## Global Constraints

- `history_mutation.payload.items` is the canonical typed content source.
- Never infer a transcript from cwd, timestamps, titles, or newest-file order.
- Never parse JavaScript orchestration strings to infer shell commands or patches.
- Ignore reasoning and developer, system, and user messages.
- Never mix terminal output into a turn after typed content has been published.
- Never replay a prompt after it may have reached TraeX.
- Preserve existing SQLite transactions, outbox idempotency, frozen-page behavior, and the 9,000-character page limit.
- Do not migrate existing unidentified panes automatically; they stay on terminal mode until explicit reset or replacement.
- Do not include unrelated working-tree changes in these commits.

---

### Task 1: Lock down the real typed transcript contract

**Files:**
- Modify: `tests/fixtures/task-jz33-transcript.jsonl`
- Modify: `tests/traex-transcript.test.ts`
- Modify: `src/domain/ports.ts`

**Interfaces:**
- Produces: `TraexTranscriptOpenResult`, a discriminated union that distinguishes a cursor from a bounded fallback reason.
- Produces test fixtures with real `history_mutation` assistant-message, function-call, and function-call-output shapes.

- [ ] **Step 1: Replace the misleading fixture with sanitized real typed records**

Keep the matching `session_meta` record and add append mutations shaped like the real transcript:

```json
{"type":"history_mutation","payload":{"operation":"append","items":[{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"Typed answer"}]}]}}
{"type":"history_mutation","payload":{"operation":"append","items":[{"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec","arguments":"{\"input\":\"opaque orchestration\"}"}]}}
{"type":"history_mutation","payload":{"operation":"append","items":[{"type":"function_call_output","id":"fco-1","call_id":"call-1","output":[{"type":"input_text","text":"fixture output"}]}]}}
```

- [ ] **Step 2: Define explicit open outcomes**

Replace the nullable reader result with these exact contracts in `src/domain/ports.ts`:

```ts
export type TraexTranscriptFallbackReason =
  | "missing_session_identity"
  | "unsupported_session_identity"
  | "transcript_not_found"
  | "ambiguous_transcript"
  | "transcript_validation_failed";

export type TraexTranscriptOpenResult =
  | { mode: "typed"; cursor: TraexTranscriptCursorPort }
  | { mode: "terminal"; reason: TraexTranscriptFallbackReason };

export interface TraexTranscriptReaderPort {
  open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult>;
}
```

- [ ] **Step 3: Write red tests for assistant message projection**

Assert that only assistant `output_text` is emitted and that reasoning plus developer, system, and user messages are absent. Include multiple `output_text` parts in one assistant message and preserve their order.

- [ ] **Step 4: Write red tests for stateful tool pairing and deduplication**

Append a `function_call`, read once, append its matching `function_call_output` in a later record, and read again. Assert that the tool name and opaque typed arguments are emitted once, the matching result is emitted once, duplicate item IDs are suppressed, and unmatched or malformed call IDs are ignored.

- [ ] **Step 5: Write red tests for every open fallback reason**

Cover missing session identity, non-TraeX or path identity, zero filename matches, multiple matches, and mismatched or malformed `session_meta`.

- [ ] **Step 6: Run the focused tests and observe the intended failures**

Run: `npx vitest run tests/traex-transcript.test.ts --reporter=verbose`

Expected: failures show that `history_mutation` is currently ignored and `open()` still returns `null` or a raw cursor.

- [ ] **Step 7: Commit the red contract tests**

```bash
git add src/domain/ports.ts tests/fixtures/task-jz33-transcript.jsonl tests/traex-transcript.test.ts
git commit -m "test: define typed transcript message contract"
```

### Task 2: Implement stateful typed-item rendering

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptOpenResult` and `TraexTranscriptFallbackReason` from Task 1.
- Produces: a cursor whose `readDelta()` emits each safe typed item at most once and keeps pending call identity across reads.

- [ ] **Step 1: Define Zod schemas for mutation envelopes and safe item variants**

Use schemas equivalent to:

```ts
const historyMutationSchema = z.object({
  operation: z.literal("append"),
  items: z.array(z.unknown())
});
const messageItemSchema = z.object({
  type: z.literal("message"), id: z.string(), role: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
}).passthrough();
const functionCallSchema = z.object({
  type: z.literal("function_call"), id: z.string(), call_id: z.string(),
  name: z.string(), arguments: z.string()
}).passthrough();
const functionOutputSchema = z.object({
  type: z.literal("function_call_output"), id: z.string(),
  call_id: z.string(), output: z.unknown()
}).passthrough();
```

- [ ] **Step 2: Add cursor-owned projection state**

Add `emittedItemIds: Set<string>` and `callsById: Map<string, { name: string }>` to `FileTraexTranscriptCursor`. Parse only complete newline-terminated records, accept only append mutations, and process items in source order.

- [ ] **Step 3: Render assistant content and paired tools**

Render assistant `output_text` parts as Markdown. Render a function call as a neutral `tool` fence containing the declared name and opaque argument payload; do not inspect nested `exec` JavaScript. Render a matching output as a separate `text` fence using only declared output fields. Apply secret redaction before bounding the combined delta.

- [ ] **Step 4: Return bounded fallback reasons from lookup**

Classify validation without leaking paths or contents:

```ts
if (!session) return { mode: "terminal", reason: "missing_session_identity" };
if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value))
  return { mode: "terminal", reason: "unsupported_session_identity" };
```

Distinguish no match, multiple matches, and invalid metadata. Unexpected filesystem failures map to `transcript_validation_failed`.

- [ ] **Step 5: Remove the obsolete event-message content renderer**

Delete schemas and rendering branches for `event_msg.agent_message`, `exec_command_end`, and `patch_apply_end`. Unknown top-level records remain ignored.

- [ ] **Step 6: Run the reader tests**

Run: `npx vitest run tests/traex-transcript.test.ts --reporter=verbose`

Expected: all transcript tests pass, including real fixture pairing and duplicate suppression.

- [ ] **Step 7: Commit the reader correction**

```bash
git add src/runtime/traex-transcript.ts tests/traex-transcript.test.ts
git commit -m "fix: consume typed TraeX transcript items"
```

### Task 3: Make turn source selection explicit and non-mixing

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `tests/concurrency-controls.integration.test.ts`
- Modify: `tests/helpers/create-test-router.ts` only if the port signature requires fixture updates

**Interfaces:**
- Consumes: `TraexTranscriptReaderPort.open(): Promise<TraexTranscriptOpenResult>`.
- Produces: one `outputMode` per turn and structured `fallbackReason` logs.

- [ ] **Step 1: Rewrite workflow fakes for discriminated open results**

Typed fakes return `{ mode: "typed", cursor }`; terminal fakes return `{ mode: "terminal", reason }`. Do not use nullable cursors in new tests.

- [ ] **Step 2: Add a red test for turn-start diagnostics**

Use a Pino destination or logger spies and assert that `turn-started` contains `outputMode: "typed"` for an opened cursor and `outputMode: "terminal", fallbackReason: "missing_session_identity"` for an unidentified binding.

- [ ] **Step 3: Add a red test for pre-emission read failure**

Make the first typed read throw, emit safe terminal output from Herdr, and assert that the final answer is terminal-only and a warning records `fallbackReason: "transcript_read_failed"`.

- [ ] **Step 4: Strengthen the no-mixing test**

Make one typed delta succeed and the next read fail. Assert the answer contains only typed content, excludes all terminal text, and the failure log records that terminal fallback was suppressed after typed emission.

- [ ] **Step 5: Implement one source mode per turn**

Represent the local turn state as a discriminated union rather than parallel nullable variables:

```ts
type TurnOutputSource =
  | { mode: "terminal"; fallbackReason: string }
  | { mode: "typed"; cursor: TraexTranscriptCursorPort; emitted: boolean; chunks: string[] };
```

Log the selected mode in `turn-started`. Permit typed-to-terminal transition only when `emitted === false`; otherwise retain typed mode and finalize from accumulated typed chunks.

- [ ] **Step 6: Keep completion source-specific**

For typed turns, finalize from accumulated typed chunks and never consult streamed terminal content. For terminal turns, retain the existing terminal stream and final extraction behavior. Continue reading terminal output for Herdr state observation only; do not project it into a typed answer.

- [ ] **Step 7: Run focused workflow tests**

Run: `npx vitest run tests/concurrency-controls.integration.test.ts tests/traex-transcript.test.ts --reporter=verbose`

Expected: typed, terminal fallback, and no-mixing cases all pass.

- [ ] **Step 8: Commit workflow mode enforcement**

```bash
git add src/coordinator/prompt-run-workflow.ts tests/concurrency-controls.integration.test.ts tests/helpers/create-test-router.ts
git commit -m "fix: enforce typed transcript turn mode"
```

### Task 4: Align active architecture documentation

**Files:**
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: the final typed reader and workflow behavior from Tasks 2 and 3.
- Produces: current operational documentation; the historical correction plan remains under `docs/superpowers/`.

- [ ] **Step 1: Correct the Answer streaming section**

Replace the claim that `event_msg.agent_message`, `exec_command_end`, and `patch_apply_end` drive Answer content. State that `history_mutation.payload.items` is canonical, list the safe item kinds, document call/result pairing, and explain source-mode locking.

- [ ] **Step 2: Document rollout behavior**

State explicitly that existing panes without native identity remain terminal and that bridge-created or reset panes become typed only after exact SessionStart identity registration.

- [ ] **Step 3: Check documentation consistency**

Run:

```bash
rg -n "event_msg|history_mutation|typed|terminal fallback|agent session" docs/architecture.md docs/superpowers/specs/2026-08-27-traex-typed-transcript-design.md
git diff --check -- docs/architecture.md
```

Expected: no active architecture claim contradicts the spec and no whitespace errors are reported.

- [ ] **Step 4: Commit the documentation correction**

```bash
git add docs/architecture.md
git commit -m "docs: align typed transcript architecture"
```

### Task 5: Verify build and live rollout boundaries

**Files:**
- No source changes expected.

**Interfaces:**
- Verifies the exact code and operational behavior produced by Tasks 1-4.

- [ ] **Step 1: Run focused regression tests**

Run: `npx vitest run tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts tests/herdr-adapter.test.ts tests/report-traex-session.test.ts --reporter=verbose`

Expected: all focused tests pass.

- [ ] **Step 2: Run repository verification**

Run in order:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 0 failures, typecheck and build exit 0, and no whitespace errors.

- [ ] **Step 3: Confirm the deployment artifact before restart**

Read `dist/build-info.json`, confirm its `gitCommit` matches `git rev-parse HEAD`, and confirm no intended implementation files remain uncommitted. Do not include unrelated user changes in a commit.

- [ ] **Step 4: Restart through the supported plugin action**

Run: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

Then query `http://127.0.0.1:<configured-port>/status` and confirm readiness, build identity, SQLite, Herdr, Lark, lease, and outbox health.

- [ ] **Step 5: Verify the legacy terminal path without mutation**

Observe one existing binding that has no `agent_session_value`. Send no synthetic prompt unless explicitly authorized. On its next ordinary turn, confirm `turn-started` logs `outputMode=terminal` and `fallbackReason=missing_session_identity`.

- [ ] **Step 6: Verify typed mode on a fresh or explicitly reset pane**

Create or reset a bridge-managed pane only with explicit operator authorization because this changes live session state. Confirm Herdr reports `agent_session.agent=traex`, `kind=id`, and the exact UUID; confirm exactly one matching transcript exists; then send a harmless prompt and verify `outputMode=typed` plus Answer content traceable to `history_mutation` typed items.

- [ ] **Step 7: Record final evidence**

Report test totals, build ID, deployed commit, legacy fallback observation, typed-mode observation, and any skipped live step with its reason. Do not claim the migration is live-complete unless Step 6 succeeds.
