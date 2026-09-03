# Thread Primary and Worker-Only Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bound Lark thread the sole Primary and restrict durable agent instances to Workers.

**Architecture:** Preserve the existing binding prompt FIFO as the Primary runtime and present it explicitly in the instance directory. Restrict `agent_instances` to Worker lifecycle state. Re-key Primary MCP credentials and authorization from instance generations to binding generations and active binding prompts.

**Tech Stack:** TypeScript, Zod, SQLite, Vitest, Herdr, TraeX MCP

**Spec:** `docs/superpowers/specs/2026-08-30-thread-primary-worker-only-instances-design.md`

## Global Constraints

- A bound Lark thread is the only Primary authority for that thread.
- `agent_instances` manages Workers only; do not synthesize a Primary row.
- Default Primary messages must use the existing binding prompt FIFO.
- Never replay a prompt that may have reached TraeX.
- Worker topology changes remain human-only.
- Legacy Primary rows are retained for explicit operator cleanup, never silently converted or deleted.
- Do not stage or modify `docs/archive/superpowers/plans/2026-08-30-standalone-service-cutover.md` or `TODO.md`.

---

### Task 1: Remove the unused Primary instance configuration surface

**Files:**
- Modify: `src/config.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/setup/setup-workflow.ts`
- Modify: `src/setup/setup-checks.ts`
- Modify: `src/setup/setup-summary.ts`
- Modify: `config/projects.example.json`
- Modify: `tests/config.test.ts`
- Modify: `tests/setup-workflow.test.ts`
- Modify: `tests/setup-checks.test.ts`
- Modify: `README.md`
- Modify: `docs/feishu-group-usage.md`

**Interfaces:**
- Consumes: project registry fields `id`, `displayName`, `description`, `workspaceId`, `cwd`, and `maxInstances`.
- Produces: `ProjectConfig` without `instances`; `maxInstances` means the maximum number of Worker rows.

- [ ] **Step 1: Write failing configuration and setup tests**

Change `tests/config.test.ts` so a minimal project normalizes without an `instances` field and an input containing `instances` is rejected by the strict project schema. Change `tests/setup-workflow.test.ts` so first-run setup emits only project metadata and `maxInstances`. Remove setup-check expectations that probe configured instance templates.

```ts
expect(validateProjectRegistry({
  defaultProjectId: "bridge",
  projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge", workspaceId: "w1", cwd: "/repo" }]
}).projects[0]).toEqual(expect.objectContaining({ maxInstances: 8 }));

expect(() => validateProjectRegistry({
  defaultProjectId: "bridge",
  projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge", workspaceId: "w1", cwd: "/repo", instances: [] }]
})).toThrow();
```

- [ ] **Step 2: Run the focused tests and observe the old schema failure**

Run: `npx vitest run tests/config.test.ts tests/setup-workflow.test.ts tests/setup-checks.test.ts`

Expected: FAIL because `instances` is still accepted/defaulted and setup still generates Primary and Worker templates.

- [ ] **Step 3: Remove the dead configuration model**

Delete `projectInstanceSchema` and the `instances` field from `projectSchema` and `ProjectConfig`. Remove instance-template creation, validation probes, and summary rows. Make the project schema strict so stale `instances` content is rejected with an actionable message from config validation rather than silently ignored. Update the example registry and active docs to describe `maxInstances` as a Worker limit.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/config.test.ts tests/setup-workflow.test.ts tests/setup-checks.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/domain/types.ts src/setup/setup-workflow.ts src/setup/setup-checks.ts src/setup/setup-summary.ts config/projects.example.json tests/config.test.ts tests/setup-workflow.test.ts tests/setup-checks.test.ts README.md docs/feishu-group-usage.md
git commit -m "refactor: remove primary instance templates" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 2: Make instance controls and cards Worker-only

**Files:**
- Modify: `src/domain/commands.ts`
- Modify: `src/domain/agent-instance.ts`
- Modify: `src/coordinator/instance-control-workflow.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/cards/instance-directory-card.ts`
- Modify: `src/cards/instance-control-card.ts`
- Modify: `src/cards/instance-detail-card.ts`
- Modify: `tests/instance-control.integration.test.ts`
- Modify: `tests/instance-routing.integration.test.ts`
- Modify: `tests/instance-cards.test.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: active `Binding` from `findBindingByLarkScope()` and Worker rows from `listAgentInstances(projectId)`.
- Produces: `CreateWorkerCommand` with no role field; `renderInstanceDirectoryCard({ project, workers, target, primary })`; worker-only instance actions.

- [ ] **Step 1: Write the failing card and workflow regression tests**

Add a bound-thread fixture with no instance rows. Assert `/instances` renders `PRIMARY 当前 Thread`, `TARGET Primary (当前 Thread)`, `WORKERS 0`, and `暂无 Worker`; assert it contains `创建 Worker` and no Primary role option or promotion action. Add a callback test that includes forged `formValues.role = "primary"` and still calls control creation with a Worker-only command.

```ts
expect(text).toContain("PRIMARY");
expect(text).toContain("当前 Thread");
expect(text).toContain("WORKERS");
expect(text).not.toContain("未设置");
expect(text).not.toContain("选择角色");
expect(control.createWorker).toHaveBeenCalledWith(expect.not.objectContaining({ role: expect.anything() }));
```

Add control tests proving Worker creation is the only public creation operation and the project limit counts Worker rows. Add a SQLite regression fixture containing a legacy Primary row and assert `listWorkers()` excludes it while `getAgentInstance(legacyPrimary.id)` still returns it unchanged.

- [ ] **Step 2: Run the focused tests and observe the current behavior**

Run: `npx vitest run tests/instance-cards.test.ts tests/instance-routing.integration.test.ts tests/instance-control.integration.test.ts`

Expected: FAIL on `PRIMARY 未设置`, the role selector, and Primary creation/promotion behavior.

- [ ] **Step 3: Introduce the Worker-only control boundary**

Replace `CreateInstanceCommand` with:

```ts
export interface CreateWorkerCommand {
  actor: ControlActor;
  projectId: string;
  name: string;
  agentKind: AgentKind;
  model: string | null;
  start: boolean;
}
```

Rename `InstanceControlWorkflow.create()` to `createWorker()`, hard-code `role: "worker"` and `workspace.kind: "git-worktree"`, count only Worker rows against `maxInstances`, and add `listWorkers(projectId)` that filters legacy Primary rows without mutating them. Remove `setPrimary()` from the supported workflow and remove the `设为 Primary` card action. Keep low-level legacy rows readable for diagnostics, but do not expose `setPrimaryAgentInstance()` through a coordinator or card path.

- [ ] **Step 4: Render the binding-backed Primary explicitly**

Pass the active binding into directory rendering as:

```ts
interface ThreadPrimaryView {
  bindingId: string;
  generation: number;
  paneId: string | null;
  state: Binding["state"];
}
```

Render it separately from Worker rows. The instance count becomes `WORKERS`. Change the form title/button to `创建 Worker`, remove the role selector, and ignore any forged role field at normalization. If a command targets symbolic Primary, let `InboundRouter` retain the existing active-binding path; only an explicit Worker target is handled by `InstanceInteractionWorkflow`.

- [ ] **Step 5: Preserve inspectable failed Worker creation**

When `createWorker({ start: true })` persists the Worker but startup fails, return a typed result containing the persisted failed Worker instead of throwing an unqualified error:

```ts
type CreateWorkerResult =
  | { status: "created"; instance: AgentInstance }
  | { status: "created-start-failed"; instance: AgentInstance; error: string };
```

Render a warning Toast/card for `created-start-failed`, including the Worker name and redacted `lastError`, so a retry cannot create a duplicate unnoticed.

- [ ] **Step 6: Run focused verification**

Run: `npx vitest run tests/instance-cards.test.ts tests/instance-routing.integration.test.ts tests/instance-control.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/commands.ts src/domain/agent-instance.ts src/coordinator/instance-control-workflow.ts src/coordinator/instance-interaction-workflow.ts src/cards/instance-directory-card.ts src/cards/instance-control-card.ts src/cards/instance-detail-card.ts tests/instance-control.integration.test.ts tests/instance-routing.integration.test.ts tests/instance-cards.test.ts tests/sqlite-store.test.ts
git commit -m "fix: make thread primary and instances workers" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 3: Fence Primary tools with binding generations and prompts

**Files:**
- Modify: `src/domain/commands.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/runtime/primary-tool-gateway.ts`
- Modify: `src/runtime/primary-tool-broker.ts`
- Modify: `src/cli/primary-tools-mcp.ts`
- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/main.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/primary-tool-broker.test.ts`
- Modify: `tests/primary-tool-gateway.integration.test.ts`
- Modify: `tests/primary-tools-mcp.test.ts`
- Modify: `tests/primary-worker-flow.integration.test.ts`
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `tests/project-selection-integration.test.ts`
- Modify: `tests/provisioning-recovery.test.ts`
- Modify: `tests/pane-thread-lifecycle-integration.test.ts`

**Interfaces:**
- Consumes: `Binding.id`, `Binding.generation`, `PromptJob.id`, binding project, and Worker instance generations.
- Produces: `ControlActor` variant `{ kind: "thread-primary"; projectId; bindingId; bindingGeneration; parentPromptId }`; gateway requests `{ bindingId, generation, capability, tool, arguments }`.

- [ ] **Step 1: Write failing store and gateway tests**

Add a binding-backed fixture with one active binding prompt and one Worker. Assert a credential issued for `(bindingId, generation)` can list and prompt that Worker, derives `parentPromptId` from the active `prompt_jobs` row, and rejects all of these: wrong capability, advanced binding generation, archived binding, no active prompt, cross-project Worker, and legacy Primary instance target.

```ts
const launch = gateway.issueBinding(binding.id, binding.generation);
await expect(call(socketPath, {
  bindingId: binding.id, generation: binding.generation,
  capability: launch.environment.SWARM_PRIMARY_CAPABILITY,
  tool: "promptInstance", arguments: { instanceId: worker.id, task: "review", idempotencyKey: "child" }
})).resolves.toMatchObject({ ok: true });
```

- [ ] **Step 2: Run the focused tests and observe instance-backed authorization failure**

Run: `npx vitest run tests/sqlite-store.test.ts tests/primary-tool-broker.test.ts tests/primary-tool-gateway.integration.test.ts tests/primary-tools-mcp.test.ts tests/primary-worker-flow.integration.test.ts tests/project-selection-integration.test.ts tests/provisioning-recovery.test.ts tests/pane-thread-lifecycle-integration.test.ts`

Expected: FAIL because capability storage and parent-turn lookup require a Primary instance and instance turn.

- [ ] **Step 3: Migrate capability storage to bindings**

Replace `primary_tool_capabilities(instance_id, instance_generation, ...)` with a schema-convergent table keyed by `binding_id` and `binding_generation`, with `binding_id` referencing `bindings(id)`. Detect the legacy columns during migration, drop and recreate only this ephemeral credential table, and leave prompts, bindings, Workers, workspaces, and their history untouched. Add store methods:

```ts
setBindingPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean;
verifyBindingPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean;
getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
```

The verification query must require the exact binding generation plus `state = 'active'`, `lifecycle = 'active'`, and `attachment = 'attached'`. The active prompt query returns exactly one `state = 'running' AND dispatch_kind = 'turn'` prompt for that binding; zero or multiple matches fail closed, and steering prompts never confer authority.

- [ ] **Step 4: Change gateway, broker, and actor authorization**

Rename gateway APIs to `issueBinding(bindingId, expectedGeneration)` and `configurationForBinding(bindingId, generation)`. Store the issued credential against the exact binding generation that will own the pane; binding provisioning must not apply the instance-runtime `generation + 1` convention. Change the MCP client flag from `--instance` to `--binding`, reject legacy `instanceId` request fields through the strict schema, and emit requests shaped as `{ bindingId, generation, capability, tool, arguments }`. In `handle()`, derive project and `parentPromptId` from SQLite and construct the `thread-primary` actor. Update `InstanceMessagingWorkflow` to validate that actor through the current binding record and active ordinary prompt, and allow it to target only same-project Worker rows.

- [ ] **Step 5: Inject Primary tools into binding TraeX runtimes**

Before each new binding pane allocation path (`new`, `reset`, replacement, and recoverable replacement), issue the credential for the generation that the resulting binding/pane will retain and pass its environment through `HerdrPaneCreationOptions.environment`; call `startTraex` with the gateway MCP arguments. If provisioning resumes after pane allocation, use `configurationForBinding()` for that persisted generation rather than minting a different capability. For attached/discovered panes that were not started with the credential, report Primary tools as unavailable until a user-controlled replacement/reset creates a credentialed pane; do not inject environment into a running process and do not restart it automatically.

At prompt dispatch, gateway authorization uses the server-owned active prompt. It does not issue a new credential per prompt and never embeds prompt IDs in client-controlled arguments. Binding archive, replacement, or generation advance invalidates the old capability by query fencing; credential cleanup must not mutate prompt state or trigger replay.

- [ ] **Step 6: Rewrite the product-flow integration test**

Use one binding-backed Primary prompt plus one Worker instance. Prove the Worker executes exactly once, duplicate idempotency keys do not replay, Worker completion does not create another Primary turn, and the Primary prompt completes with the Worker result.

- [ ] **Step 7: Run focused and repository-wide verification**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts tests/primary-tool-broker.test.ts tests/primary-tool-gateway.integration.test.ts tests/primary-tools-mcp.test.ts tests/primary-worker-flow.integration.test.ts tests/herdr-adapter.test.ts tests/project-selection-integration.test.ts tests/provisioning-recovery.test.ts tests/pane-thread-lifecycle-integration.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: every command exits `0`; no test is skipped.

- [ ] **Step 8: Commit**

```bash
git add src/domain/commands.ts src/domain/ports.ts src/store/sqlite-store.ts src/runtime/primary-tool-gateway.ts src/runtime/primary-tool-broker.ts src/cli/primary-tools-mcp.ts src/coordinator/instance-messaging-workflow.ts src/coordinator/binding-provisioning-workflow.ts src/main.ts tests/sqlite-store.test.ts tests/primary-tool-broker.test.ts tests/primary-tool-gateway.integration.test.ts tests/primary-tools-mcp.test.ts tests/primary-worker-flow.integration.test.ts tests/herdr-adapter.test.ts tests/project-selection-integration.test.ts tests/provisioning-recovery.test.ts tests/pane-thread-lifecycle-integration.test.ts
git commit -m "refactor: bind primary tools to threads" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 4: Deploy and verify the thread-backed Primary flow

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: canonical `install.sh`, `npm run swarm:restart`, `/status`, and live Lark instance cards.
- Produces: live evidence that the current thread is Primary and only Workers can be created.

- [ ] **Step 1: Inspect the live safety gate**

Run `npm run swarm:status` and require zero binding and instance in-flight work, zero pending outbox deliveries, completed startup recovery, healthy SQLite, and held lease. Do not use `--force` without a new explicit user authorization.

- [ ] **Step 2: Install and safely restart**

Run `./install.sh`, then `npm run swarm:restart`. Verify two consecutive status samples have the expected build, exact listener PID ownership, completed recovery, healthy SQLite, held lease, and `/ready` success.

- [ ] **Step 3: Perform live Lark acceptance**

Open `/instances` in a bound thread and verify `PRIMARY 当前 Thread`, zero or more Workers, and no Primary creation/promotion. Create one stopped Worker with a unique test name, confirm exactly one Worker and workspace row exist, then use the normal safe removal plan to remove it. Do not remove a dirty worktree.

- [ ] **Step 4: Verify no replay and record evidence**

Compare prompt dispatch counters and relevant binding/instance rows before and after deployment. Confirm no existing prompt or Worker turn was submitted twice.
