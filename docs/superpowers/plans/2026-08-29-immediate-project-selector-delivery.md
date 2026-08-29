# Immediate Project Selector Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/swarm new` and `/projects` attempt delivery of their durable project selector card before command handling returns.

**Architecture:** Keep project selections and CardKit replies in the SQLite outbox, then invoke the existing serialized outbox dispatcher immediately through a narrow injected port. A failed immediate attempt remains durable and is retried by the existing notifier and safety scan.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-29-immediate-project-selector-delivery-design.md`

## Global Constraints

- The durable outbox remains the only Lark delivery path.
- Do not call `LarkPort.replyCard` directly from provisioning.
- Preserve project selection authorization, expiry, idempotency, provisioning, topic creation, and initial-prompt behavior.
- Immediate delivery failures must not roll back the selection or outbox intent.
- Do not start subagents for this implementation.

---

### Task 1: Deliver durable selector cards immediately

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Modify: `tests/project-selection-integration.test.ts`
- Modify: `docs/feishu-group-usage.md`

**Interfaces:**
- Consumes: `LarkOutboxDispatcher.requestScan(force?: boolean): Promise<void>`
- Produces: `ImmediateOutboundDispatcher.requestScan(force?: boolean): Promise<void>` injected as `immediateOutbound` into `BindingProvisioningWorkflow`.

- [ ] **Step 1: Write failing command-delivery tests**

Add integration assertions that block `replyCard`, invoke `/swarm new` and `/projects`, and prove `handleMessage` remains pending until the selector delivery attempt completes. Add a failure case where `replyCard` rejects and verify the project selection plus outbound row remain persisted for retry.

- [ ] **Step 2: Run the focused tests and confirm the missing immediate drain**

Run: `npx vitest run tests/project-selection-integration.test.ts`

Expected: the command promise resolves before the blocked selector delivery is released, or the immediate-failure behavior is not observed.

- [ ] **Step 3: Add the narrow dispatcher port and inject it**

Add this contract in `src/domain/ports.ts`:

```ts
export interface ImmediateOutboundDispatcher {
  requestScan(force?: boolean): Promise<void>;
}
```

Add `immediateOutbound: ImmediateOutboundDispatcher` to the provisioning options. Pass `channelPublisher` from `src/main.ts` and the test publisher from `tests/helpers/create-test-router.ts`.

- [ ] **Step 4: Request immediate delivery without weakening durability**

After `createProjectSelection` and `outboundWork.wake()`, await `immediateOutbound.requestScan()`. Catch and log errors with `selectionId`, `eventId`, and outcome `deferred`; do not delete or fail the persisted selection or outbox row.

- [ ] **Step 5: Document the command response behavior**

Update `docs/feishu-group-usage.md` to state that `/swarm new` and `/projects` immediately show the project list card and that transient delivery failures remain retryable.

- [ ] **Step 6: Verify focused behavior**

Run: `npx vitest run tests/project-selection-integration.test.ts tests/lark-outbox-dispatcher.test.ts`

Expected: all tests pass, including immediate `/swarm new`, immediate `/projects`, and durable failure recovery.

- [ ] **Step 7: Verify the repository and commit**

Run: `npm test && npm run typecheck && npm run build`

Expected: all Vitest files pass, TypeScript exits 0, and build identity is generated.

Commit:

```bash
git add src/domain/ports.ts src/coordinator/binding-provisioning-workflow.ts src/main.ts tests/helpers/create-test-router.ts tests/project-selection-integration.test.ts docs/feishu-group-usage.md
git commit -m "fix: deliver project selector immediately"
```

- [ ] **Step 8: Build after commit and deploy**

Run `npm run build`, restart the standalone 8788 service through `bash scripts/swarm-service.sh restart`, and restart the 8787 plugin through `bash plugin/service.sh restart --force` only after confirming no active workers or pending outbox work. Verify both `/status` endpoints report `ready`, the new git commit, and the generated build identity.
