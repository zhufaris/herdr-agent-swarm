# Transcript Observer Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the live transcript cursor across an attached-to-detached observer transition so the first Answer commentary is not skipped.

**Architecture:** Extract the detached observation loop from its scheduling wrapper. The normal stalled-waiter path calls that loop inline with its existing transcript source and turn supervisor; restart recovery keeps the wrapper that opens a new cursor and attaches a new supervisor.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite, Herdr CLI, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-30-transcript-observer-handoff-design.md`

## Global Constraints

- Never replay a prompt that may have reached TraeX.
- Publish transcript output only for the durably claimed exact turn.
- Preserve FIFO prompt dispatch and one ordinary turn per binding.
- Keep cursor state process-local; restart recovery uses durable turn identity.
- Do not modify or stage unrelated worktree changes.

---

### Task 1: Reproduce the handoff gap

**Files:**
- Modify: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReaderPort.open()` and `HerdrPort.runPrompt()`
- Produces: a regression test covering first commentary after `agent_prompt_stalled`

- [ ] Add a test whose first cursor claims the turn before the waiter stalls and exposes Answer content only after the stall.
- [ ] Assert that the Answer is observed before terminal completion, `open()` is called once, and `runPrompt()` is called once.
- [ ] Run `npx vitest run tests/concurrency-controls.integration.test.ts` and confirm the new assertion fails on the current implementation.

### Task 2: Hand off the live cursor

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `TurnOutputSource`, `TurnSupervisor`, and the durable prompt transcript identity
- Produces: a detached observation loop callable with either a retained or newly opened `TurnOutputSource`

- [ ] Extract the detached observation loop from the durable scheduling wrapper.
- [ ] After a dispatched waiter failure, stop and await the attached observer, persist detached state, and call the loop inline with the retained source when exact identity exists.
- [ ] Keep restart recovery opening a new cursor and attaching its own supervisor.
- [ ] Document the in-process cursor handoff and restart distinction.

### Task 3: Verify and deploy

**Files:**
- Verify: `src/coordinator/prompt-run-workflow.ts`
- Verify: `tests/concurrency-controls.integration.test.ts`
- Verify: `docs/architecture.md`

**Interfaces:**
- Consumes: repository test/build scripts and service lifecycle commands
- Produces: a tested immutable release running under the canonical user systemd unit

- [ ] Run the focused concurrency and transcript tests.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Run `./install.sh`, then restart through the supported lifecycle command when safe or explicitly authorized.
- [ ] Verify expected and observed build IDs match, ownership matches, readiness is ready, startup recovery is completed, and SQLite integrity is healthy.
- [ ] Run a live Answer Card test and compare the first transcript commentary timestamp with the first delivered `stream_content` timestamp.
