# Topic-Scoped Instance Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make instance commands and card callbacks use the project fixed by the current Lark topic binding.

**Architecture:** `InstanceInteractionWorkflow` resolves one conversation context from the durable binding before consulting mutable target state. Bound topics use a binding-scoped target key and reject project changes; unbound conversations retain explicit project selection with a stable scope key. Instance cards carry that key through callbacks.

**Tech Stack:** TypeScript, SQLite, Vitest, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-29-topic-scoped-instance-routing-design.md`

## Global Constraints

- An active topic binding fixes the topic project.
- Preserve existing SQLite schema and transaction behavior.
- Do not stage unrelated worktree changes.
- Use ESM `.js` imports and existing compact TypeScript style.

---

### Task 1: Lock the regression with integration tests

**Files:**
- Modify: `tests/instance-routing.integration.test.ts`

**Interfaces:**
- Consumes: `SqliteBindingStore.createPendingBinding`, `InstanceInteractionWorkflow.handleCommand`.
- Produces: executable assertions for binding project authority and topic isolation.

- [ ] Add a test that creates a binding with project `p1`, leaves conversation target absent, sends `/instances`, and expects the `p1` directory instead of the project-selection rejection.
- [ ] Add two same-chat topic bindings and assert their instance target keys do not overwrite each other.
- [ ] Add a bound-topic `/project p2` test and assert that it is rejected without changing the topic context.
- [ ] Run `npx vitest run tests/instance-routing.integration.test.ts` and confirm the new assertions fail for the current implementation.

### Task 2: Resolve binding-authoritative context

**Files:**
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/cards/instance-directory-card.ts`
- Modify: `src/cards/instance-detail-card.ts`
- Modify: `src/cards/instance-control-card.ts`
- Test: `tests/instance-routing.integration.test.ts`

**Interfaces:**
- Consumes: `findBindingByLarkScope(topicId, rootMessageId)` and existing conversation-target persistence.
- Produces: an internal context `{ projectId, targetKey, boundProject }` and callback values containing `conversationKey`.

- [ ] Add a resolver that returns the binding project and `binding:<id>` key when a binding exists.
- [ ] Use a topic/root-derived key for unbound conversations, retaining `chatId` only as the last fallback.
- [ ] Reject `/project` when it differs from an existing binding project.
- [ ] Pass `conversationKey` through directory, detail, creation, steering, and removal cards; use it when setting the selected instance.
- [ ] Run `npx vitest run tests/instance-routing.integration.test.ts` and confirm all routing tests pass.

### Task 3: Verify and commit

**Files:**
- Verify all files changed in Tasks 1 and 2.

**Interfaces:**
- Consumes: the completed routing behavior.
- Produces: verified source and tests ready for deployment.

- [ ] Run `npx vitest run tests/instance-routing.integration.test.ts tests/instance-control.integration.test.ts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` on task-owned files and inspect the staged diff.
- [ ] Commit only the plan, routing source, card source, and routing tests with `fix: scope instance routing to topics`.
