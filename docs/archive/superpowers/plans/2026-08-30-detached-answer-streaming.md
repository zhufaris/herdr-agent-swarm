# Detached Answer Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an Answer card updating from typed TraeX JSONL after an uncertain Herdr dispatch moves a prompt into detached observation.

**Architecture:** `PromptRunWorkflow` retains ownership of attached and detached observation. A private projection helper will turn one typed transcript observation into the existing `TurnOutputObserved` lifecycle event, so both paths use identical event, reducer, CardKit, and outbox behavior while detached completion remains fenced by matching transcript lifecycle time.

**Tech Stack:** TypeScript, Vitest, SQLite, Herdr adapter, TraeX JSONL reader, Lark CardKit outbox

**Spec:** `docs/superpowers/specs/2026-08-30-detached-answer-streaming-design.md`

## Global Constraints

- Never replay a prompt after it may have reached TraeX.
- Persist and deliver card changes through the existing lifecycle projection and SQLite outbox.
- Preserve the matching `task_complete` time fence before terminalizing a detached prompt.
- Do not read unstructured terminal output into an Answer card.

---

### Task 1: Stream typed output while detached

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/pane-thread-lifecycle-integration.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptObservation`, durable run-card `startedAt`, and the existing `TurnOutputObserved` lifecycle event.
- Produces: a private `publishTypedObservation(bindingId, promptId, observation, startedAt)` helper shared by attached and detached observers.

- [x] Add an integration test whose recovered detached transcript first emits an answer delta with an active lifecycle, then emits a matching completed lifecycle.
- [x] Assert before completion that the prompt remains `running/detached`, the run-card answer contains the delta, and Herdr prompt submission occurred only once.
- [x] Run `npx vitest run tests/pane-thread-lifecycle-integration.test.ts` and confirm the new assertion fails because detached deltas are discarded.
- [x] Extract the existing answer/status publication into `publishTypedObservation` and call it from both the attached callback/final read and detached loop.
- [x] Re-run `npx vitest run tests/pane-thread-lifecycle-integration.test.ts tests/concurrency-controls.integration.test.ts`.
- [x] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [x] Restart `herdr-agent-swarm.service` with detached/no-replay recovery for the active diagnostic turn, then verify `/ready`, build identity, and zero replay.
- [x] Commit the source, regression test, and checked implementation steps as `fix: stream detached TraeX answers`.
