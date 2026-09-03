# TraeX Typed Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with fresh verification after every task.

**Goal:** Stream Answer Card Markdown from an exactly identified TraeX typed transcript while retaining terminal text as a safe fallback.

**Architecture:** A repo-owned SessionStart hook reports TraeX's session ID to Herdr. A bounded filesystem reader verifies that ID, tails complete JSONL records from a byte cursor, renders typed assistant/tool items, and is consumed by `PromptRunWorkflow` ahead of terminal parsing.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Herdr socket API, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-traex-typed-transcript-design.md`

## Global Constraints

- Never infer a transcript from cwd, time, title, or newest-file order.
- Never parse terminal text or `exec` JavaScript arguments to guess Bash/diff boundaries.
- Never replay a prompt after it may have reached TraeX.
- Keep canonical Answer offsets and the 9,000-character CardKit page limit unchanged.
- Typed transcript failure must degrade to terminal output, not fail the turn.

---

### Task 1: Session identity hook

**Files:**
- Create: `src/cli/report-traex-session.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `package.json`
- Test: `tests/report-traex-session.test.ts`
- Test: `tests/herdr-adapter.test.ts`

**Interfaces:**
- Produces: `reportTraexSession(input, environment)` and a TraeX `SessionStart` hook command injected by `startTraex`.

- [ ] Write tests that accept only SessionStart UUID identities and send `pane.report_agent_session` for the current Herdr pane.
- [ ] Verify the tests fail before implementation.
- [ ] Implement the bounded stdin parser and Unix-socket report command.
- [ ] Inject the hook with a process-local TraeX `-c` override in `startTraex`.
- [ ] Run the two focused test files and commit.

### Task 2: Typed transcript reader and renderer

**Files:**
- Create: `src/runtime/traex-transcript.ts`
- Create: `tests/traex-transcript.test.ts`
- Create: `tests/fixtures/task-jz33-transcript.jsonl`

**Interfaces:**
- Produces: `TraexTranscriptReader.open(session): Promise<TraexTranscriptCursor | null>` and `cursor.readDelta(): Promise<string>`.

- [ ] Add sanitized task-jz33 assistant, `exec`, and tool-output records.
- [ ] Write failing tests for exact session resolution, byte cursors, partial records, ordering, pairing, ignored reasoning, and redaction.
- [ ] Implement verified transcript lookup without heuristic fallback.
- [ ] Implement complete-record tailing and typed Markdown rendering.
- [ ] Run the focused test file and commit.

### Task 3: Workflow integration

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/main.ts`
- Modify: `tests/concurrency-controls.integration.test.ts`
- Modify: `tests/traex-output-parser.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReader.open(session)` and `TraexTranscriptCursor.readDelta()`.
- Produces: typed-first `TurnOutputObserved` events with terminal fallback.

- [ ] Write an integration test that streams typed assistant/tool records once and ignores misleading terminal markers.
- [ ] Write a fallback test for missing/invalid session identity.
- [ ] Add the transcript port to composition and open the cursor before prompt dispatch.
- [ ] Prefer typed deltas per observation; preserve the existing terminal fallback and completion rules.
- [ ] Run focused coordinator, parser, Markdown, and CardKit tests and commit.

### Task 4: Release verification

**Files:**
- Modify: `docs/architecture.md`

- [ ] Document typed transcript authority and terminal fallback.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and confirm a clean worktree after commit.
- [ ] Rebuild after the final commit, restart the Herdr plugin service, and verify observed identity, readiness, Lark, Herdr, SQLite, lease, and outbox health.
