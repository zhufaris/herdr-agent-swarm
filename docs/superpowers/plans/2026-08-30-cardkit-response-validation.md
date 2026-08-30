# CardKit Response Validation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent HTTP-successful CardKit business failures from being recorded as delivered main-card updates.

**Architecture:** Keep validation at the Lark adapter boundary. Every CardKit operation must reject a present non-zero response `code`; existing outbox retry, classification, and quarantine behavior remains authoritative after the adapter throws.

**Tech Stack:** TypeScript, Lark Node SDK, Vitest.

**Spec:** Approved diagnosis and design from the 2026-08-30 main-card incident.

## Global Constraints

- Do not log card payloads, form values, credentials, or tokens.
- Preserve CardKit sequence and idempotency behavior.
- Preserve existing HTTP/network exception behavior.
- Do not restart while prompt or instance work is active or uncertain.

---

### Task 1: Reject CardKit business failures

**Files:**
- Modify: `src/adapters/lark-adapter.ts`
- Test: `tests/lark-adapter.test.ts`

**Interfaces:**
- Consumes: Lark SDK responses with optional `code`, `msg`, and `data`.
- Produces: adapter methods that resolve only for absent/zero business codes and otherwise throw a safely summarized error.

- [x] Add failing tests for non-zero `card.update`, `card.idConvert`, `cardElement.content`, and `card.settings` responses.
- [x] Run `npx vitest run tests/lark-adapter.test.ts` and confirm the new assertions fail.
- [x] Add one response assertion helper and apply it to all CardKit operations, including create.
- [x] Re-run `npx vitest run tests/lark-adapter.test.ts` and confirm it passes.
- [x] Run `npx vitest run tests/lark-outbox-dispatcher.test.ts` to verify thrown adapter errors remain durable delivery failures.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Inspect the final diff and current service safety state before any deployment decision.
