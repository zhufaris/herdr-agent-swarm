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

function setup(operatorOpenIds: readonly string[] = []) {
  store = new SqliteBindingStore(":memory:");
  const create = (id: string, role: "primary" | "worker", projectId = "p1") => store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: `ws-${id}`, kind: role === "primary" ? "main-checkout" : "shared-read-only", cwd: projectId === "p1" ? "/repo" : "/repo-two", branch: null, baseCommit: "base" } });
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const messaging = { submit: vi.fn(async () => ({ accepted: true })), steer: vi.fn(), interrupt: vi.fn(), inspect: vi.fn() };
  const control = {
    list: (projectId: string) => store!.listAgentInstances(projectId),
    inspect: (id: string) => { const instance = store!.getAgentInstance(id)!; return { instance, workspace: store!.getWorkspaceLease(instance.workspaceLeaseId)! }; },
    create: vi.fn(async (input) => create(input.name, input.role)), start: vi.fn(), stop: vi.fn(), setPrimary: vi.fn(),
    planRemoval: vi.fn(async ({ instanceId }) => { const instance = store!.getAgentInstance(instanceId)!; const workspace = store!.getWorkspaceLease(instance.workspaceLeaseId)!; return store!.createInstanceRemovalPlan({ id: "plan-1", instanceId, instanceGeneration: instance.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: "clean-fp", safe: true, reason: "clean", state: "pending", createdAt: "now" }); }),
    confirmRemoval: vi.fn(async () => true)
  };
  const workflow = new InstanceInteractionWorkflow({ projects: [project, secondProject], operatorOpenIds, store, control: control as never, messaging: messaging as never, drivers: { describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }) } as never, outbound: outbound as never });
  return { create, workflow, outbound, messaging, control };
}

describe("instance routing", () => {
  it("uses the bound topic project for /instances without a separate conversation target", async () => {
    const { create, workflow, outbound } = setup();
    create("primary", "primary");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });

    await workflow.handleCommand({ ...message("/instances"), topicId: "topic-1" }, { kind: "instances" });

    const card = JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2]);
    expect(card).toContain("Project · Agent Instances");
    expect(card).not.toContain("请先使用");
  });

  it("keeps selected instance targets isolated between topics in one chat", async () => {
    const { create, workflow } = setup();
    const first = create("first", "worker");
    const second = create("second", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });
    store!.createPendingBinding({ id: "binding-2", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-2", rootMessageId: "root-2", title: "two" });

    await workflow.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: first.id, generation: first.generation, conversationKey: "binding:binding-1" } });
    await workflow.handleCardAction({ messageId: "card-2", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: second.id, generation: second.generation, conversationKey: "binding:binding-2" } });

    expect(store!.getConversationTarget("binding:binding-1")?.target).toMatchObject({ kind: "instance", instanceId: first.id });
    expect(store!.getConversationTarget("binding:binding-2")?.target).toMatchObject({ kind: "instance", instanceId: second.id });
  });

  it("rejects a card target from outside the bound topic project", async () => {
    const { create, workflow } = setup();
    const otherProjectWorker = create("other-worker", "worker", "p2");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "one" });

    await expect(workflow.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: otherProjectWorker.id, generation: otherProjectWorker.generation, conversationKey: "binding:binding-1" } })).resolves.toEqual({ toast: { type: "warning", content: "实例不属于当前话题项目。" } });

    expect(store!.getConversationTarget("binding:binding-1")).toBeNull();
  });

  it("does not let /project move an existing topic binding", async () => {
    const { workflow, outbound } = setup();
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });

    await workflow.handleCommand({ ...message("/project p2"), topicId: "topic-1" }, { kind: "project", projectId: "p2" });

    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("已固定到项目");
    expect(store!.getConversationTarget("binding:binding-1")).toBeNull();
  });

  it("shows the instance directory instead of choosing when no primary exists", async () => {
    const { workflow, outbound } = setup(); store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    await workflow.handleCommand(message("/instances"), { kind: "instances" });
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("暂无实例");
  });
  it("keeps a persistent target but /to remains a one-shot destination", async () => {
    const { create, workflow, messaging } = setup(); const primary = create("primary", "primary"); create("worker", "worker");
    store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    await workflow.handleCommand(message("/to worker review", "m1"), { kind: "to", name: "worker", text: "review" });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", content: { kind: "turn", text: "review" } }));
    expect(store!.getConversationTarget("root:root")).toEqual({ projectId: "p1", target: { kind: "primary" } });
    expect(primary.role).toBe("primary");
  });
  it("reloads generation before applying a card callback", async () => {
    const { create, workflow } = setup(); const worker = create("worker", "worker");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: worker.id, generation: 1 } })).resolves.toEqual({ toast: { type: "warning", content: "实例状态已变化，请刷新后重试。" } });
    expect(store!.getConversationTarget("chat")).toBeNull();
  });
  it("creates an instance only when the form submitter matches the operator who opened it", async () => {
    const { workflow } = setup();
    const form = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_form", projectId: "p1" } });
    expect(JSON.stringify(form)).toContain("instance_create_submit");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u2", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", role: "worker", agent_kind: "traex", model: "", start: "false" } })).resolves.toEqual({ toast: { type: "error", content: "只有发起此操作的用户可以提交。" } });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1" }, formValues: { name: "reviewer", role: "worker", agent_kind: "traex", model: "", start: "false" } })).resolves.toMatchObject({ toast: { type: "success" } });
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
    expect(control.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", start: false }));
  });
  it("reloads the current instance before steering from an actor-bound form", async () => {
    const { create, workflow, messaging } = setup(); const worker = create("worker", "worker");
    const opened = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_form", instanceId: worker.id, generation: worker.generation } });
    expect(JSON.stringify(opened)).toContain("instance_steer_submit");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_submit", instanceId: worker.id, generation: 1, requestedBy: "u1" }, formValues: { steer_text: "focus tests" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(messaging.steer).not.toHaveBeenCalled();
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
  it("rejects instance controls outside the configured operator allowlist", async () => {
    const { workflow, outbound } = setup(["owner"]);
    await workflow.handleCommand({ ...message("/instances"), actorOpenId: "viewer" }, { kind: "instances" });
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain("没有 Agent 管理权限");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "viewer", value: { action: "instance_create_form", projectId: "p1" } })).resolves.toEqual({ toast: { type: "error", content: "你没有 Agent 管理权限。" } });
  });
});
