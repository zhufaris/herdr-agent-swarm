# Answer Tool Activity Style Port Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the validated `herdr-lark-bridge` command tool activity rendering in Herdr Agent Swarm.

**Architecture:** Keep complete canonical tool output in the transcript projector and perform line folding only in the Lark Markdown render layer. Protect bounded tool blocks from avoidable page splits while retaining canonical source offsets.

**Tech Stack:** TypeScript, Vitest, Lark CardKit Markdown

**Spec:** `docs/superpowers/specs/2026-08-28-answer-tool-activity-style-port-design.md`

## Global Constraints

- Port only source commit `ca321c9` behavior.
- Preserve durable canonical answer text and source offsets.
- Preserve current secret redaction and command-output bounds.
- Preserve the uncommitted Lark `post` normalization fix.

---

### Task 1: Command Activity Heading

**Files:**
- Modify: `src/runtime/tool-activity-projector.ts`
- Test: `tests/tool-activity-projector.test.ts`

**Interfaces:**
- Consumes: `ToolActivityDescriptor` plus raw tool result.
- Produces: canonical Markdown from `projectToolResult()`.

- [x] Update source-derived expectations for successful, running, and failed commands.
- [x] Run the focused projector test and observe failure.
- [x] Add the `◆ **Ran**` heading while preserving fenced command/output and redaction.
- [x] Run the focused projector test and observe success.

### Task 2: Display-Time Output Folding

**Files:**
- Modify: `src/runtime/lark-markdown.ts`
- Test: `tests/answer-stream.test.ts`

**Interfaces:**
- Consumes: canonical Answer Card Markdown and canonical page offset.
- Produces: bounded rendered page plus the next canonical source offset.

- [x] Add source-derived folding tests for JSON, Git, test, and plain output.
- [x] Add a pagination test that keeps one bounded tool block together.
- [x] Run the focused answer-stream test and observe failure.
- [x] Fold output at render time and protect fitting tool blocks from line splits.
- [x] Run focused tests, typecheck, and build.
- [x] Restart the standalone service and verify readiness on the new build.
