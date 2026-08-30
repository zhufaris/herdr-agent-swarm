# Unified Card Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Answer and Main Card convergence scheduling for bounded latency, latest-wins delivery, durable recovery, and observable lag.

**Architecture:** Keep durable views and outbox semantics intact. Generalize the existing coalescing scheduler around stable card keys, route both card workflows and their delivery checkpoints through it, and expose scheduler diagnostics through the health status provider.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, Lark CardKit.

**Spec:** `docs/superpowers/specs/2026-08-30-unified-card-convergence-design.md`

## Global Constraints

- Answer normal updates flush within 1,500 ms; Main normal updates within 2,500 ms.
- Terminal, blocked, failed, pagination, and checkpoint convergence are immediate.
- Preserve the 9,000-character Answer page limit and immutable frozen pages.
- Never replay a TraeX prompt because of card delivery or recovery.
- Preserve existing user changes in `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md`.

---

### Task 1: Generic convergence scheduler

**Files:** Modify `src/events/card-update-scheduler.ts`; test `tests/card-update-scheduler.test.ts`.

**Interfaces:** Produce `schedule(cardKey, version, options)` plus bounded `diagnostics()`; consume an async fresh-state convergence callback.

- [ ] Add failing tests for per-request delay, priority promotion, latest-version coalescing, in-flight rerun, retry, and diagnostics.
- [ ] Generalize the scheduler without adding durable business state.
- [ ] Run `npx vitest run tests/card-update-scheduler.test.ts`.
- [ ] Commit the independently passing scheduler change.

### Task 2: Route Answer and Main through one scheduler

**Files:** Modify `src/events/conversation-view-projector.ts`, `src/coordinator/main-card-workflow.ts`; test `tests/event-card-integration.test.ts`, `tests/main-card-workflow.test.ts`, and `tests/card-update-scheduler.test.ts`.

**Interfaces:** Consume stable keys `answer:<promptId>` and `main:<bindingId>` and priority-aware scheduling.

- [ ] Add failing tests showing Main updates debounce latest-wins and both checkpoint callbacks schedule immediate fresh-state convergence.
- [ ] Route event and checkpoint paths through the shared scheduler.
- [ ] Keep workflows responsible only for reading durable state and reserving outbox intent.
- [ ] Run focused projector, Main, Answer, and scheduler tests.
- [ ] Commit the routing change.

### Task 3: Durable latest-wins and monotonic visibility

**Files:** Modify `src/store/sqlite-store.ts`, `src/coordinator/answer-page-workflow.ts`; test `tests/sqlite-store.test.ts`, `tests/answer-page-workflow.test.ts`, and `tests/lark-outbox-dispatcher.test.ts`.

**Interfaces:** Preserve existing `reserveMainCard`, Answer page reservation, and outbox contracts.

- [ ] Add failing tests for stale pending Main dismissal, late-version rejection, and terminal Answer shrink preservation.
- [ ] Make Main reservation compact obsolete pending snapshots transactionally.
- [ ] Retain last delivered Answer page content whenever terminal canonical content cannot render at that page offset.
- [ ] Run focused persistence and delivery tests.
- [ ] Commit the durability change.

### Task 4: Diagnostics and bounded activity

**Files:** Modify scheduler diagnostics types and `src/main.ts` health status composition; test `tests/health-server.test.ts` or the nearest status-provider test and `tests/run-card.test.ts`.

**Interfaces:** Expose counts and timestamps only; never expose prompt/card content.

- [ ] Add failing tests for pending counts, oldest age, coalesced count, failures, and last success.
- [ ] Include scheduler diagnostics in `/status`.
- [ ] Verify Main Card renders no more than eight recent activity summaries.
- [ ] Run focused diagnostics and rendering tests.
- [ ] Commit the observability change.

### Task 5: End-to-end verification and deployment

**Files:** Update tests only if a missing cross-layer assertion is found.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build` after the final commit so build identity is current.
- [ ] Restart with `bash scripts/swarm-service.sh restart`; use supported forced detach only if the lifecycle gate reports active work.
- [ ] Verify `/ready`, observed build identity, zero stalled outbox lanes, and inactive legacy services.
- [ ] Observe live Answer/Main desired-to-delivered convergence and record measured latency.

