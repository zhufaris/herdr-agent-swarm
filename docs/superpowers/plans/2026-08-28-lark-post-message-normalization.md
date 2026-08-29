# Lark Post Message Normalization Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize Lark topic-group `post` messages so slash commands reach the existing inbound router.

**Architecture:** Extend only the Lark adapter normalization boundary. Parse bounded Lark rich-text nodes into the existing `IncomingLarkMessage` contract without changing coordinator, store, or delivery behavior.

**Tech Stack:** TypeScript, Lark Node SDK, Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-08-28-lark-post-message-normalization-design.md`

## Global Constraints

- Preserve support for existing `text` events.
- Ignore malformed and unsupported payloads safely.
- Do not add network calls to message normalization.
- Keep bot mention detection tied to the configured Bot Open ID.

---

### Task 1: Normalize Topic-Group Post Messages

**Files:**
- Modify: `src/adapters/lark-adapter.ts`
- Test: `tests/lark-adapter.test.ts`

**Interfaces:**
- Consumes: Lark `im.message.receive_v1` event payloads.
- Produces: `normalizeMessage(data, botOpenId): IncomingLarkMessage | null`.

- [x] Add a failing test showing a bare `/projects` post becomes an incoming message.
- [x] Run `npx vitest run tests/lark-adapter.test.ts` and confirm the post test fails.
- [x] Implement minimal post document parsing while preserving text behavior.
- [x] Run the focused test and confirm it passes.
- [x] Add configured-bot and other-user mention cases and make them pass.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Restart `herdr-agent-swarm.service` and verify readiness.
- [x] Send a fresh topic-group command and verify its message ID is persisted and replied to.
