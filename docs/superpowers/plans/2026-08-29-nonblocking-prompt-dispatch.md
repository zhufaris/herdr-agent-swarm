# Non-blocking prompt dispatch implementation plan

> **For agentic workers:** Execute inline with test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start durable prompt work without waiting for Lark lifecycle projection subscribers.

**Architecture:** Keep SQLite prompt, run-card, and Answer Card intent creation atomic. Move the scheduler wake immediately after successful insertion and before awaiting `PromptQueued` or `SteeringQueued` publication; retain outbox lane ordering and all existing recovery paths.

**Tech Stack:** TypeScript ESM, SQLite, Vitest, systemd user service.

**Spec:** `docs/superpowers/specs/2026-08-29-nonblocking-prompt-dispatch-design.md`

## Global Constraints

- Preserve one ordinary turn per binding and FIFO ordering.
- Persist prompt and outbox intent before scheduler wake.
- Preserve no-replay recovery and automatic-steering fencing.
- Do not bypass the durable Lark outbox or its answer-lane ordering.

---

### Task 1: Prove scheduler wake is independent of projection latency

**Files:**
- Modify: `tests/steering-integration.test.ts`
- Modify: `src/coordinator/inbound-router.ts`

**Interfaces:**
- Consumes: `PromptAcceptanceStore.acceptClassifiedPrompt`, `PromptWorkScheduler.wake`, and `LifecycleEventPublisher.publish`.
- Produces: a durable prompt-ready or steering-ready wake before lifecycle subscribers finish.

- [ ] Add an integration test that blocks a `PromptQueued` listener, starts `handleMessage` without awaiting it, and verifies the scheduler receives `prompt-ready` while the listener remains blocked.
- [ ] In the same assertion window, verify the prompt and its pending `stream_card_create` row already exist.
- [ ] Run `npx vitest run tests/steering-integration.test.ts` and confirm the test fails against the current ordering.
- [ ] Move the scheduler wake in `enqueueClassified` to immediately after durable insertion and outbound wake, before lifecycle publication; remove the later duplicate wake. Apply the same ordering to the explicit steering enqueue path.
- [ ] Re-run the focused test and confirm it passes.
- [ ] Run adjacent event-card, outbox, concurrency, and SQLite tests.
- [ ] Commit as `perf: dispatch prompts before card projection`.

### Task 2: Verify and deploy

**Files:**
- No additional source files expected.

**Interfaces:**
- Consumes: repository build and `swarm:*` lifecycle commands.
- Produces: deployed build whose observed identity matches the current commit.

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Run `npm run swarm:install` and `npm run swarm:restart -- --force`.
- [ ] Verify `npm run swarm:status` reports `active`, `ready`, and matching expected/observed Build IDs.
- [ ] Send a fresh Lark message and query SQLite for queue, first-content, execution, and final-delivery timings against the 2.033-second and 3.559-second baseline.
