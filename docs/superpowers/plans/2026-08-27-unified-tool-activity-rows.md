# Unified Tool Activity Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate tool call/result lines with one consistently ordered result row per synchronous tool activity.

**Architecture:** `projectToolCall` continues to classify and retain a bounded descriptor but emits no visible entry. `projectToolResult` renders status, category, stored target, and only a useful optional summary; the transcript cursor keeps exact `call_id` pairing and can append a later terminal result after a running result.

**Tech Stack:** TypeScript, Node.js ESM, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-typed-tool-activity-projection-design.md`

## Global Constraints

- Assistant `output_text` remains unchanged.
- Successful raw tool output never enters the Answer.
- Failure detail remains limited to the last 20 non-empty redacted lines and 4,000 characters.
- Command targets remain Markdown inline code, single-line, redacted, and bounded.
- Transcript offsets, persistence, pagination, recovery, and outbox semantics do not change.
- Preserve unrelated concurrent work in all overlapping files.

---

### Task 1: Define the unified result renderer

**Files:**
- Modify: `tests/tool-activity-projector.test.ts`
- Modify: `src/runtime/tool-activity-projector.ts`

**Interfaces:**
- Consumes: `projectToolCall(name: string, argumentsJson: string): ProjectedToolCall`.
- Produces: `projectToolResult(descriptor: ToolActivityDescriptor, output: unknown): string`.

- [x] Change call tests to require an empty `entry` for every category while retaining the expected descriptor category and target.
- [x] Add result assertions for <code>✓ Command · `npm test`</code>, `✓ Read · src/main.ts`, `… Wait · session 263 · 运行中`, and <code>✗ Command · `npm test` · exit 2</code>.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts` and confirm the old two-line protocol fails.
- [x] Implement a shared result-row renderer with fixed field order and omit generic success wording when no useful summary exists.
- [x] Use the neutral target `command` whenever an `exec` wrapper has no safely extractable inner command.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts` and confirm green.

### Task 2: Integrate delayed rows with the transcript cursor

**Files:**
- Modify: `tests/traex-transcript.test.ts`
- Modify only if needed: `src/runtime/traex-transcript.ts`

**Interfaces:**
- Consumes: the empty call entry and target-bearing result output from Task 1.
- Preserves: exact non-empty `call_id` pairing and item-ID deduplication across reads.

- [x] Update existing cursor assertions so calls emit nothing and paired results emit one target-bearing row.
- [x] Add a running-then-terminal result test proving both result item IDs can append their respective states for the same call.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts` and confirm green.

### Task 3: Document, verify, and release

**Files:**
- Modify: `docs/architecture.md`
- Include: `docs/superpowers/plans/2026-08-27-unified-tool-activity-rows.md`

- [x] Replace the call/result two-line architecture description with delayed one-row terminal projection and the running exception.
- [x] Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Stage only this feature's hunks and files, preserving unrelated concurrent work, then commit with `feat: unify tool activity result rows`.
- [ ] Rebuild after commit and restart through `herdr plugin action invoke restart --plugin herdr-lark-bridge`.
- [ ] Verify expected and observed commit/build identity match, readiness is `ready`, startup recovery is `completed`, Lark and Herdr are connected, and no outbox lane is stalled.
