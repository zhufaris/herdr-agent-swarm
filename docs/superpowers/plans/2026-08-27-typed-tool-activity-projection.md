# Typed Tool Activity Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project every typed TraeX tool call/result into compact, deterministic Answer Card activity entries while retaining bounded diagnostics only for failures.

**Architecture:** Introduce a pure `tool-activity-projector` module that classifies structured calls, stores a compact descriptor, and renders terminal result summaries. Keep `TraexTranscriptReader` focused on JSONL framing, item deduplication, and exact `call_id` pairing; it delegates all tool presentation to the projector.

**Tech Stack:** TypeScript, Node.js ESM, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-typed-tool-activity-projection-design.md`

## Global Constraints

- Successful tool output never enters the Answer; assistant `output_text` remains unchanged.
- Failed tool output retains only the last 20 non-empty redacted lines and at most 4,000 characters.
- Successful skill loads retain no output and render only one completed Skill entry.
- Targets are single-line, Markdown-safe, secret-free, and at most 160 characters.
- Transcript offsets, item idempotency, source-mode selection, persistence, pagination, and outbox semantics do not change.

---

### Task 1: Pure call projection

**Files:**
- Create: `src/runtime/tool-activity-projector.ts`
- Create: `tests/tool-activity-projector.test.ts`

**Interfaces:**
- Produces: `projectToolCall(name: string, argumentsJson: string): { descriptor: ToolActivityDescriptor; entry: string }`.
- `ToolActivityDescriptor` contains only bounded category, target, and skill names; it never stores raw arguments.

- [x] Write table-driven failing tests for Skill, Read, Search, Edit, Command, Wait, Agent, and unknown Tool calls using representative real nested `exec` arguments.
- [x] Assert every target is one line, at most 160 characters, and excludes environment values, full prompts, and serialized JSON.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts` and confirm red.
- [x] Implement bounded parsed-value traversal, trusted skill recognition, wrapper-command recognition, category selection, target extraction, Markdown escaping, and fallback labels.
- [x] Run the projector tests and confirm green.

### Task 2: Pure result projection

**Files:**
- Modify: `src/runtime/tool-activity-projector.ts`
- Modify: `tests/tool-activity-projector.test.ts`

**Interfaces:**
- Produces: `projectToolResult(descriptor: ToolActivityDescriptor, output: unknown): string`.
- Produces: `redactToolActivitySecrets(value: string): string` for pre-tail and final-entry redaction.

- [x] Write failing tests for string, text-part-array, unknown, successful, failed, and running results.
- [x] Add success recognizers for Vitest/Jest counts, generic pass/fail/skip counts, and generated build identity; assert raw stdout is absent.
- [x] Add failure cases with 30 non-empty lines and embedded secrets; assert only lines 11-30 remain after redaction and the entry is at most 4,000 characters.
- [x] Add skill success and failure cases; assert success output is completely absent and failure keeps only the bounded diagnostic tail.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts` and confirm red.
- [x] Implement explicit status parsing, safe normalization, deterministic summaries, failure tailing, redaction, and bounds.
- [x] Run the projector tests and confirm green.

### Task 3: Cursor integration

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Modify: `tests/traex-transcript.test.ts`

**Interfaces:**
- Consumes: `projectToolCall` and `projectToolResult`.
- Changes `callsById` to `Map<string, ToolActivityDescriptor>`.

- [x] Update existing transcript expectations so generic calls/results assert compact activity entries and absence of raw arguments/output.
- [x] Add cross-read and duplicate tests proving descriptors pair only through exact non-empty `call_id`.
- [x] Run the transcript suite and confirm red before integration.
- [x] Remove inline call/output rendering and skill recognition from `traex-transcript.ts`; delegate to the projector and retain item deduplication.
- [x] Run `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts` and confirm green.

### Task 4: Integration and release

**Files:**
- Modify: `docs/architecture.md`
- Include: `docs/superpowers/plans/2026-08-27-typed-tool-activity-projection.md`

- [x] Replace the narrow skill projection paragraph with the general compact tool activity protocol and failure-tail boundary.
- [x] Run `npx vitest run tests/concurrency-controls.integration.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/event-card-integration.test.ts tests/answer-page-recovery.integration.test.ts`.
- [x] Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Stage only the projector, transcript integration, their tests, architecture update, and this plan; commit with `feat: compact typed tool activity output`.
- [ ] Rebuild after commit and deploy only through `herdr plugin action invoke restart --plugin herdr-lark-bridge`.
- [ ] Verify live commit/build identity, `readiness.status=ready`, `startupRecovery.state=completed`, connected Lark/Herdr sockets, and zero pending outbox rows.
