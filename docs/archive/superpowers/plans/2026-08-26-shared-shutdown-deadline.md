# Shared Shutdown Deadline Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task. Steps use checkbox syntax for tracking.

**Goal:** Bound graceful bridge shutdown with one absolute deadline while preserving no-replay semantics and never closing SQLite below unsettled writers.

**Architecture:** `BridgeRuntimeShutdown` owns a single `ShutdownContext` with an absolute deadline and `AbortSignal`. It asks ingress, coordinator, projector, and outbox components to stop in dependency order, races each operation against the same remaining budget, and retains ownership resources if write-capable work has not settled after abort. `PromptRunWorkflow` consumes the context to detach possibly-dispatched observers at deadline without requeueing them.

**Tech Stack:** Node.js AbortController, TypeScript, Vitest, SQLite-backed workflow state.

**Spec:** `docs/superpowers/specs/2026-08-26-shared-shutdown-deadline-design.md`

## Global Constraints

- One shutdown request owns one immutable absolute deadline; subsequent requests return the same promise.
- Do not stop TraeX or replay any prompt during shutdown.
- Do not close or deactivate SQLite while a write-capable component is unsettled.
- Reuse the existing 30-second prompt shutdown grace as the initial bridge-wide budget.
- Logs must contain component names and timing only, never prompt text or terminal output.

---

### Task 1: Define a shared shutdown context

**Files:**
- Create: `src/runtime/shutdown-context.ts`
- Modify: `src/runtime/shutdown.ts`
- Test: `tests/runtime-shutdown.test.ts`

- [ ] Add `ShutdownContext` with `signal`, `deadlineAt`, and `remainingMs()`, backed by one `AbortController`.
- [ ] Export `DEFAULT_SHUTDOWN_GRACE_MS = 30_000` and use a monotonic deadline calculation in the shutdown controller.
- [ ] Test that all components receive the same context and that a second signal cannot extend its deadline.

### Task 2: Bound phases and protect durable ownership

**Files:**
- Modify: `src/runtime/shutdown.ts`
- Test: `tests/runtime-shutdown.test.ts`

- [ ] Stop ingress before application and delivery components.
- [ ] Race every stop request against `context.remainingMs()`; record timed-out components and observe late failures.
- [ ] On deadline, abort the shared signal once and give write-capable components a bounded settlement window.
- [ ] Keep the shutdown promise pending and skip write fence, lease release, and SQLite close until every writer settles.
- [ ] Test component failure isolation, global-not-per-component deadline behavior, late rejection observation, and the non-cooperative writer guard.

### Task 3: Make coordinator and prompt cancellation context-aware

**Files:**
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/main.ts`
- Test: `tests/prompt-run-safety-scan.test.ts` or focused prompt shutdown tests

- [ ] Change coordinator and prompt workflow stop contracts to accept `ShutdownContext`.
- [ ] Stop accepting inbound and control work immediately, then wait only while the shared context has time.
- [ ] On context abort, mark active observed prompts detached through the existing no-replay path; unclaimed prompts remain queued.
- [ ] Construct prompt workflow and runtime shutdown with the same default budget in `main.ts`.

### Task 4: Verify the integration

**Files:**
- Test: `tests/runtime-shutdown.test.ts`
- Test: prompt workflow shutdown test file

- [ ] Run focused shutdown and prompt tests.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit the implementation as a focused reliability change after verification.
