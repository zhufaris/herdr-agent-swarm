import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { InstanceInteractionWorkflow } from "../src/coordinator/instance-interaction-workflow.js";
import { normalizeCardActionEvent } from "../src/adapters/lark-adapter.js";
import type { IncomingLarkMessage } from "../src/domain/types.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
const project = { id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" };
const secondProject = { id: "p2", displayName: "Project Two", description: "second project", workspaceId: "w2", cwd: "/repo-two" };
const message = (text: string, messageId = text): IncomingLarkMessage => ({ eventId: messageId, messageId, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "u1", text, mentionsBot: true, isRootMessage: false });
function callbackValue(card: unknown, action: string): Record<string, unknown> {
  const visit = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.action === action) return record;
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) { for (const item of child) { const found = visit(item); if (found) return found; } }
      else { const found = visit(child); if (found) return found; }
    }
    return null;
  };
  const found = visit(card);
  if (!found) throw new Error(`Missing card callback: ${action}`);
  return found;
}

function setup(operatorOpenIds: readonly string[] = []) {
  store = new SqliteBindingStore(":memory:");
  const create = (id: string, role: "primary" | "worker", projectId = "p1") => store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: `ws-${id}`, kind: role === "primary" ? "main-checkout" : "shared-read-only", cwd: projectId === "p1" ? "/repo" : "/repo-two", branch: null, baseCommit: "base" } });
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const messaging = { submit: vi.fn(async () => ({ accepted: true })), steer: vi.fn(), interrupt: vi.fn(), inspect: vi.fn() };
  const control = {
    listWorkers: (projectId: string) => store!.listAgentInstances(projectId).filter(({ role }) => role === "worker"),
    inspect: (id: string) => { const instance = store!.getAgentInstance(id)!; return { instance, workspace: store!.getWorkspaceLease(instance.workspaceLeaseId)! }; },
    createWorker: vi.fn(async (input) => ({ status: "created" as const, instance: create(input.name, "worker") })), start: vi.fn(), stop: vi.fn(),
    planRemoval: vi.fn(async ({ instanceId }) => { const instance = store!.getAgentInstance(instanceId)!; const workspace = store!.getWorkspaceLease(instance.workspaceLeaseId)!; return store!.createInstanceRemovalPlan({ id: "plan-1", instanceId, instanceGeneration: instance.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: "clean-fp", safe: true, reason: "clean", state: "pending", createdAt: "now" }); }),
    confirmRemoval: vi.fn(async () => true)
  };
  const workflow = new InstanceInteractionWorkflow({ projects: [project, secondProject], operatorOpenIds, store, control: control as never, messaging: messaging as never, drivers: { describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }) } as never, outbound: outbound as never });
  return { create, workflow, outbound, messaging, control };
}

describe("instance routing", () => {
  it("uses the bound topic project for /instances without a separate conversation target", async () => {
    const { workflow, outbound } = setup();
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });

    await workflow.handleCommand({ ...message("/instances"), topicId: "topic-1" }, { kind: "instances" });

    const card = JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2]);
    expect(card).toContain("Project · Agent Instances");
    expect(card).toContain("当前 Thread");
    expect(card).toContain("WORKERS");
    expect(card).not.toContain("请先使用");
  });

  it("keeps selected instance targets isolated between topics in one chat", async () => {
    const { create, workflow } = setup();
    const first = create("first", "worker");
    const second = create("second", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });
    store!.createPendingBinding({ id: "binding-2", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-2", rootMessageId: "root-2", title: "two" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached" });
    store!.updateBinding("binding-2", { state: "active", lifecycle: "active", attachment: "attached" });

    await workflow.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: first.id, generation: first.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 1 } });
    await workflow.handleCardAction({ messageId: "card-2", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: second.id, generation: second.generation, conversationKey: "binding:binding-2", bindingId: "binding-2", bindingGeneration: 1 } });

    expect(store!.getConversationTarget("binding:binding-1")?.target).toMatchObject({ kind: "instance", instanceId: first.id });
    expect(store!.getConversationTarget("binding:binding-2")?.target).toMatchObject({ kind: "instance", instanceId: second.id });
  });

  it("rejects create and open callbacks from a stale binding generation", async () => {
    const { create, workflow, control } = setup();
    const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2 });

    const stale = { bindingId: "binding-1", bindingGeneration: 1, conversationKey: "binding:binding-1" };
    await expect(workflow.handleCardAction({ messageId: "create", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1", ...stale }, formValues: { name: "new-worker", agent_kind: "traex", start: "false" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(workflow.handleCardAction({ messageId: "open", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_open", instanceId: worker.id, generation: worker.generation, ...stale } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(control.createWorker).not.toHaveBeenCalled();
  });

  it("rejects create-form callbacks after their binding is archived", async () => {
    const { workflow } = setup();
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });
    store!.updateBinding("binding-1", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    await expect(workflow.handleCardAction({ messageId: "create", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_form", projectId: "p1", conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 1 } })).resolves.toEqual({ toast: { type: "warning", content: "话题上下文已变化，请重新打开实例目录。" } });
  });

  it("includes the binding fence in directory, create-form, and detail controls", async () => {
    const { create, workflow, outbound } = setup();
    const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "one" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", generation: 3 });
    await workflow.handleCommand({ ...message("/instances"), topicId: "topic-1" }, { kind: "instances" });
    const directory = JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2]);
    expect(directory).toContain('"bindingId":"binding-1"');
    expect(directory).toContain('"bindingGeneration":3');

    const createForm = await workflow.handleCardAction({ messageId: "create", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_form", projectId: "p1", conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 3 } });
    expect(JSON.stringify(createForm)).toContain('"bindingGeneration":3');
    const detail = await workflow.handleCardAction({ messageId: "open", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_open", instanceId: worker.id, generation: worker.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 3 } });
    expect(JSON.stringify(detail)).toContain('"bindingGeneration":3');
  });

  it("rejects a card target from outside the bound topic project", async () => {
    const { create, workflow } = setup();
    const otherProjectWorker = create("other-worker", "worker", "p2");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached" });

    await expect(workflow.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: otherProjectWorker.id, generation: otherProjectWorker.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 1 } })).resolves.toEqual({ toast: { type: "warning", content: "实例不属于当前话题项目。" } });

    expect(store!.getConversationTarget("binding:binding-1")).toBeNull();
  });

  it("does not let /project move an existing topic binding", async () => {
    const { workflow, outbound } = setup();
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });

    await workflow.handleCommand({ ...message("/project p2"), topicId: "topic-1" }, { kind: "project", projectId: "p2" });

    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("已固定到项目");
    expect(store!.getConversationTarget("binding:binding-1")).toBeNull();
  });

  it("renders an explicit unbound state after selecting a project outside a binding", async () => {
    const { workflow, outbound } = setup();
    await workflow.handleCommand(message("/project p1"), { kind: "project", projectId: "p1" });
    const card = JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2]);
    expect(card).toContain("未绑定 Thread");
    expect(card).not.toContain("当前 Thread");
    expect(card).not.toContain("generation 0");
  });

  it("shows the current thread Primary and an empty Worker directory", async () => {
    const { workflow, outbound } = setup(); store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    await workflow.handleCommand(message("/instances"), { kind: "instances" });
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("暂无 Worker");
  });
  it("keeps a persistent target but /to remains a one-shot destination", async () => {
    const { create, workflow, messaging } = setup(); create("worker", "worker");
    store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    await workflow.handleCommand(message("/to worker review", "m1"), { kind: "to", name: "worker", text: "review" });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", content: { kind: "turn", text: "review" } }));
    expect(store!.getConversationTarget("root:root")).toEqual({ projectId: "p1", target: { kind: "primary" } });
  });
  it("leaves symbolic Primary messages to the binding FIFO", async () => {
    const { workflow, messaging } = setup();
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });
    store!.setConversationTarget({ chatId: "binding:binding-1", projectId: "p1", target: { kind: "primary" } });

    await expect(workflow.handleOrdinaryMessage({ ...message("continue", "m-primary"), topicId: "topic-1" })).resolves.toBe(false);
    expect(messaging.submit).not.toHaveBeenCalled();
  });
  it("reloads generation before applying a card callback", async () => {
    const { create, workflow } = setup(); const worker = create("worker", "worker");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: worker.id, generation: 1 } })).resolves.toEqual({ toast: { type: "warning", content: "实例状态已变化，请刷新后重试。" } });
    expect(store!.getConversationTarget("chat")).toBeNull();
  });
  it("creates a Worker only when the form submitter matches the operator who opened it", async () => {
    const { workflow, control } = setup();
    const form = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_form", projectId: "p1" } });
    expect(JSON.stringify(form)).toContain("instance_create_submit");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u2", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", role: "worker", agent_kind: "traex", model: "", start: "false" } })).resolves.toEqual({ toast: { type: "error", content: "只有发起此操作的用户可以提交。" } });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", role: "primary", agent_kind: "traex", model: "", start: "false" } })).resolves.toMatchObject({ toast: { type: "success" } });
    expect(control.createWorker).toHaveBeenCalledWith(expect.not.objectContaining({ role: expect.anything() }));
    expect(store!.listAgentInstances("p1").find(({ name }) => name === "reviewer")).toBeDefined();
  });
  it("creates an instance from the CardKit v2 form callback shape", async () => {
    const { workflow, control } = setup();
    const action = normalizeCardActionEvent({
      context: { open_message_id: "card", open_chat_id: "chat" },
      operator: { open_id: "u1" },
      action: {
        tag: "button", name: "instance_create_submit",
        value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" },
        form_value: { name: "reviewer", role: "worker", agent_kind: "traex", model: "", start: "false" }
      }
    } as never);

    expect(action).not.toBeNull();
    await expect(workflow.handleCardAction(action!)).resolves.toMatchObject({ toast: { type: "success" } });
    expect(control.createWorker).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", name: "reviewer", agentKind: "traex", start: false }));
    expect(control.createWorker).toHaveBeenCalledWith(expect.not.objectContaining({ role: expect.anything() }));
  });
  it("warns when a persisted Worker cannot be started immediately", async () => {
    const { create, workflow, control } = setup();
    const created = create("reviewer", "worker");
    const failed = store!.checkpointAgentInstance({ instanceId: created.id, expectedGeneration: created.generation, checkpoint: "pane-allocated", observedState: "failed", pendingPaneId: "w1:p1", pendingWorkspaceId: "w1", lastError: "Bearer [REDACTED]" })!;
    vi.mocked(control.createWorker).mockResolvedValueOnce({ status: "created-start-failed", instance: failed, error: "Bearer [REDACTED]" });

    const result = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", role: "primary", agent_kind: "traex", model: "", start: "true" } });
    expect(result).toMatchObject({
      toast: { type: "warning", content: expect.stringContaining("reviewer") },
      card: expect.any(Object)
    });
    expect(JSON.stringify(result)).toContain("pane-allocated");
    expect(JSON.stringify(result)).toContain("Bearer [REDACTED]");
  });
  it("rejects forged controls for a legacy Primary row", async () => {
    const { create, workflow, control } = setup();
    const legacy = create("legacy", "primary");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_start", instanceId: legacy.id, generation: legacy.generation } })).resolves.toEqual({ toast: { type: "warning", content: "仅支持管理 Worker；当前 Thread 是唯一 Primary。" } });
    expect(control.start).not.toHaveBeenCalled();
  });
  it("reloads the current instance before steering from an actor-bound form", async () => {
    const { create, workflow, messaging } = setup(); const worker = create("worker", "worker");
    const opened = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_form", instanceId: worker.id, generation: worker.generation } });
    expect(JSON.stringify(opened)).toContain("instance_steer_submit");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_submit", instanceId: worker.id, generation: 1, requestedBy: "u1" }, formValues: { steer_text: "focus tests" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(messaging.steer).not.toHaveBeenCalled();
  });
  it("propagates a binding fence through steer form submission", async () => {
    const { create, workflow, messaging } = setup(); const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "one" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", generation: 3 });
    vi.mocked(messaging.steer).mockResolvedValue({ status: "delivered" });
    const opened = await workflow.handleCardAction({ messageId: "open", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_form", instanceId: worker.id, generation: worker.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 3 } });
    const submit = callbackValue(opened, "instance_steer_submit");
    expect(submit).toMatchObject({ bindingId: "binding-1", bindingGeneration: 3 });
    await expect(workflow.handleCardAction({ messageId: "submit", chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { steer_text: "focus tests" } })).resolves.toMatchObject({ toast: { type: "success" } });
    expect(messaging.steer).toHaveBeenCalledOnce();
    store!.updateBinding("binding-1", { generation: 4 });
    await expect(workflow.handleCardAction({ messageId: "stale", chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { steer_text: "stale" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(messaging.steer).toHaveBeenCalledOnce();
  });
  it("reloads a removal plan and never confirms unsafe or stale evidence", async () => {
    const { create, workflow, control } = setup(); const worker = create("worker", "worker");
    const planned = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_plan_removal", instanceId: worker.id, generation: worker.generation } });
    expect(JSON.stringify(planned)).toContain("instance_confirm_removal");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: worker.id, generation: 1, planId: "plan-1", requestedBy: "u1" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(control.confirmRemoval).not.toHaveBeenCalled();
    const current = store!.getAgentInstance(worker.id)!; const currentWorkspace = store!.getWorkspaceLease(current.workspaceLeaseId)!;
    store!.createInstanceRemovalPlan({ id: "dirty-plan", instanceId: current.id, instanceGeneration: current.generation, workspaceGeneration: currentWorkspace.generation, worktreeFingerprint: "dirty-fp", safe: false, reason: "dirty", state: "pending", createdAt: "now" });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: current.id, generation: current.generation, planId: "dirty-plan", requestedBy: "u1" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(control.confirmRemoval).not.toHaveBeenCalled();
  });
  it("confirms a safe removal only while the persisted evidence is current", async () => {
    const { create, workflow, control } = setup(); const worker = create("worker", "worker");
    await workflow.handleCardAction({ messageId: "plan-card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_plan_removal", instanceId: worker.id, generation: worker.generation } });
    await expect(workflow.handleCardAction({ messageId: "confirm-card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: worker.id, generation: worker.generation, planId: "plan-1", requestedBy: "u1" } })).resolves.toEqual({ toast: { type: "success", content: "实例 worker 已删除。" } });
    expect(control.confirmRemoval).toHaveBeenCalledWith({ actor: { kind: "human", userId: "u1", channel: "feishu" }, planId: "plan-1" });
  });
  it("propagates a binding fence through removal confirmation", async () => {
    const { create, workflow, control } = setup(); const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "one" });
    store!.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2 });
    const planned = await workflow.handleCardAction({ messageId: "plan", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_plan_removal", instanceId: worker.id, generation: worker.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 2 } });
    const confirm = callbackValue(planned, "instance_confirm_removal");
    expect(confirm).toMatchObject({ bindingId: "binding-1", bindingGeneration: 2 });
    await expect(workflow.handleCardAction({ messageId: "confirm", chatId: "chat", operatorOpenId: "u1", value: confirm })).resolves.toMatchObject({ toast: { type: "success" } });
    expect(control.confirmRemoval).toHaveBeenCalledOnce();
  });
  it("redacts and bounds callback failure messages", async () => {
    const { workflow, control } = setup();
    vi.mocked(control.createWorker).mockRejectedValueOnce(new Error(`Authorization: Basic credential-value password=hunter2 ${"x".repeat(700)}`));
    const result = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", agent_kind: "traex", start: "false" } });
    expect(result?.toast).toMatchObject({ type: "error", content: expect.stringContaining("[REDACTED]") });
    expect(result?.toast?.content.length).toBeLessThanOrEqual(500);
    expect(result?.toast?.content).not.toMatch(/credential-value|hunter2/);
  });
  it("rejects instance controls outside the configured operator allowlist", async () => {
    const { workflow, outbound } = setup(["owner"]);
    await workflow.handleCommand({ ...message("/instances"), actorOpenId: "viewer" }, { kind: "instances" });
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("没有 Agent 管理权限");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "viewer", value: { action: "instance_create_form", projectId: "p1" } })).resolves.toEqual({ toast: { type: "error", content: "你没有 Agent 管理权限。" } });
  });
});
