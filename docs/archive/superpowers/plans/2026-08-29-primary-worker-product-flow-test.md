# Primary to Worker Product Flow Test Implementation Plan

> **For agentic workers:** Execute this plan inline because this repository task forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic Vitest product-flow test proving a Primary can discover, dispatch to, wait for, and summarize an existing Worker exactly once, then validate the same path with the real Herdr/TraeX smoke.

**Architecture:** The test composes the production SQLite store, instance messaging workflow, scheduler, Primary tool gateway, and MCP JSON-RPC handler. A deterministic fake driver emulates the Primary's tool-use loop and the Worker's completion while all authorization, durability, event, and idempotency behavior remains production code.

**Tech Stack:** TypeScript, Vitest, Node.js Unix sockets, SQLite, Herdr, TraeX

**Spec:** `docs/superpowers/specs/2026-08-29-primary-worker-product-flow-test-design.md`

## Global Constraints

- Do not modify production workflow behavior for this test slice.
- Do not touch or stage pre-existing Lark, CardKit, queue-feedback, title, or store worktree changes.
- Do not use TraeCode sub-agents.
- Keep all fake execution deterministic and free of network, Herdr, or model dependencies.
- Preserve Primary authority, same-project Worker targeting, server-owned parent-turn identity, and durable idempotency semantics.
- Treat failure of the real smoke as an explicit acceptance blocker; do not replace it with unit-test evidence.

---

### Task 1: Deterministic Primary to Worker Product Flow

**Files:**
- Create: `tests/primary-worker-flow.integration.test.ts`

**Interfaces:**
- Consumes: `SqliteBindingStore`, `InstanceMessagingWorkflow`, `InstanceWorkScheduler`, `PrimaryToolGateway`, `handlePrimaryMcpRequest`, `AgentDriverRegistry`, and `AgentRuntimeDriver`.
- Produces: one Vitest integration test that proves the joined product path without changing production exports.

- [ ] **Step 1: Create a production-shaped fixture**

Create a temporary directory, file-backed SQLite database, and Unix socket. Add helpers that create and attach one Primary and one Worker at generation 2. Use a deterministic ID factory and close the scheduler, gateway, store, and temporary directory in `afterEach`.

```ts
const createInstance = (id: string, role: "primary" | "worker") => {
  store.createAgentInstance({
    id, projectId: "project", name: id, role, agentKind: "traex",
    model: null, desiredState: "running",
    workspace: {
      id: `workspace-${id}`,
      kind: role === "primary" ? "main-checkout" : "shared-read-only",
      cwd: "/repo", branch: null, baseCommit: "base"
    }
  });
  return store.attachAgentInstanceRuntime({
    instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "herdr",
    paneId: `${id}:pane`, nativeSessionId: null
  })!;
};
```

- [ ] **Step 2: Add the MCP-to-Gateway test adapter**

Exercise the exported JSON-RPC handler with public snake-case MCP tool names. Its invoke callback forwards the mapped camel-case method through the same newline-framed Unix socket request used by the MCP child process.

```ts
async function callPrimaryTool(name: string, args: Record<string, unknown>) {
  const response = await handlePrimaryMcpRequest({
    jsonrpc: "2.0", id: name, method: "tools/call",
    params: { name, arguments: args }
  }, (tool, arguments_) => callGateway(socketPath, {
    instanceId: primary.id, generation: primary.generation, capability,
    tool, arguments: arguments_
  }));
  const result = response as { result?: { isError?: boolean; structuredContent?: unknown } };
  expect(result.result?.isError).not.toBe(true);
  return result.result?.structuredContent;
}
```

- [ ] **Step 3: Write the full-flow assertion before finalizing the fake driver**

The test submits one human turn to the Primary and expects all of these observable outcomes:

```ts
expect(toolCalls.slice(0, 2)).toEqual(["list_instances", "prompt_instance"]);
expect(toolCalls.filter((name) => name === "wait_instance").length).toBeGreaterThanOrEqual(1);
expect(toolCalls.slice(-2)).toEqual(["inspect_instance", "prompt_instance"]);
expect(workerTurns).toHaveLength(1);
expect(workerTurns[0]).toMatchObject({
  state: "completed",
  actor: { kind: "primary-agent", instanceId: primary.id, parentTurnId: primaryTurn.id }
});
expect(workerEvents.map(({ kind }) => kind)).toContain("turn.completed");
expect(primaryTurns).toHaveLength(1);
expect(primaryTurns[0]).toMatchObject({ state: "completed", result: "PRIMARY_SUMMARY: WORKER_OK" });
expect(workerSubmitCount).toBe(1);
```

Also call `prompt_instance` again with the same key while the Primary turn is still active, assert `inserted: false`, drain the Worker again, and retain `workerSubmitCount === 1`.

- [ ] **Step 4: Run the focused test and observe the initial failure**

Run:

```bash
npx vitest run tests/primary-worker-flow.integration.test.ts
```

Expected before the fixture is complete: FAIL because the Primary fake driver has not yet performed the MCP sequence or returned the required summary.

- [ ] **Step 5: Implement the deterministic Primary and Worker driver behavior**

In `submit`, distinguish Primary and Worker by `runtime.paneId`. The Worker returns `WORKER_OK`. Configure the messaging workflow's `wake(instanceId)` callback to call `scheduler.wake(instanceId)`, allowing the Worker drain to run while the Primary drain awaits completion. The Primary lists instances, selects the known Worker, submits with idempotency key `primary-to-worker-flow`, polls `wait_instance` from cursor `0` until `turn.completed` appears, calls `inspect_instance` to read the completed turn result, repeats `prompt_instance` with the same key to prove deduplication, then returns `PRIMARY_SUMMARY: WORKER_OK`. Bound polling with a fixed deadline so failures cannot hang the suite.

```ts
if (runtime.paneId === "worker:pane") {
  workerSubmitCount += 1;
  return { status: "confirmed-delivered", runtimeCursor: "WORKER_OK" };
}
const listed = await callPrimaryTool("list_instances", {});
await callPrimaryTool("prompt_instance", {
  instanceId: worker.id, task: "Reply with WORKER_OK",
  idempotencyKey: "primary-to-worker-flow"
});
await waitForWorkerCompletion();
const inspected = await callPrimaryTool("inspect_instance", { instanceId: worker.id });
await callPrimaryTool("prompt_instance", {
  instanceId: worker.id, task: "Reply with WORKER_OK",
  idempotencyKey: "primary-to-worker-flow"
});
return { status: "confirmed-delivered", runtimeCursor: "PRIMARY_SUMMARY: WORKER_OK" };
```

- [ ] **Step 6: Run the focused test to green**

Run:

```bash
npx vitest run tests/primary-worker-flow.integration.test.ts
```

Expected: one test file and one product-flow test pass, with no open-handle warning.

- [ ] **Step 7: Run the adjacent regression suite**

Run:

```bash
npx vitest run tests/primary-worker-flow.integration.test.ts tests/primary-tool-broker.test.ts tests/primary-tool-gateway.integration.test.ts tests/primary-tools-mcp.test.ts tests/instance-messaging.integration.test.ts
```

Expected: all selected files pass.

- [ ] **Step 8: Commit only the new test and this plan**

```bash
git add tests/primary-worker-flow.integration.test.ts docs/superpowers/plans/2026-08-29-primary-worker-product-flow-test.md
git diff --cached --check
git diff --cached --stat
git commit -m "test: cover primary worker product flow"
```

---

### Task 2: Real Herdr and TraeX Acceptance

**Files:**
- Verify: `scripts/smoke-headless-multi-agent.ts`
- Verify: `package.json`

**Interfaces:**
- Consumes: the existing `smoke:headless-multi-agent` script and current Herdr pane/workspace environment.
- Produces: fresh JSON evidence for the real Primary-to-Worker runtime path.

- [ ] **Step 1: Build the current source**

Run:

```bash
npm run build
```

Expected: TypeScript compilation succeeds and `dist/cli/primary-tools-mcp.js` exists for the Primary runtime.

- [ ] **Step 2: Run the real product acceptance**

Run from a Herdr pane with `HERDR_PANE_ID` and `HERDR_WORKSPACE_ID`:

```bash
npm run smoke:headless-multi-agent -- --execute
```

Expected JSON evidence:

```json
{
  "productPath": true,
  "assertions": {
    "primaryCalledExistingWorker": true,
    "workerCompletionDidNotTriggerPrimary": true,
    "restartDidNotReplay": true
  }
}
```

- [ ] **Step 3: Inspect cleanup and report environmental failures precisely**

After the command, inspect Herdr for panes whose cwd is under the script's temporary repository. Expected: none remain. If prerequisites are missing or the real runtime fails, retain the hermetic test result but report the exact missing executable, environment variable, pane output, or failed durable turn; do not claim real acceptance.

---

### Task 3: Repository Verification and Handoff

**Files:**
- Verify: `tests/primary-worker-flow.integration.test.ts`
- Verify: `docs/superpowers/specs/2026-08-29-primary-worker-product-flow-test-design.md`
- Verify: `docs/superpowers/plans/2026-08-29-primary-worker-product-flow-test.md`

**Interfaces:**
- Consumes: the committed integration test and real-smoke evidence.
- Produces: completion evidence for this test-only slice.

- [ ] **Step 1: Run all repository tests**

```bash
npm test
```

Expected: all Vitest files and tests pass, including the new product-flow test.

- [ ] **Step 2: Run static and production build checks**

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 3: Audit requirements against evidence**

Confirm each design requirement maps to an assertion or live result: Primary discovery, same-project dispatch, server-owned parent identity, Worker completion, wait cursor, Primary summary, no automatic Primary turn, duplicate-key no replay, resource cleanup, and real Herdr/TraeX execution. Record any missing evidence as incomplete and continue work.

- [ ] **Step 4: Deployment decision**

This slice adds tests only, so do not restart the production bridge solely for this commit. Continue to the next production-code optimization; after that source change passes its checks, deploy the accumulated build through the standalone service and verify expected/observed build identity plus readiness.
