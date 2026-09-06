import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { InstanceInteractionWorkflow } from "../src/coordinator/instance-interaction-workflow.js";
import { normalizeCardActionEvent } from "../src/adapters/lark-adapter.js";
import type { IncomingLarkMessage } from "../src/domain/types.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";
import { renderWorkerMainCard } from "../src/cards/worker-main-card.js";
import { applicationPresentation } from "./helpers/presentation.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
const project = { id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" };
const secondProject = { id: "p2", displayName: "Project Two", description: "second project", workspaceId: "w2", cwd: "/repo-two" };
const message = (text: string, messageId = text): IncomingLarkMessage => ({ eventId: messageId, messageId, parentMessageId: null, chatId: "chat", topicId: "topic-default", rootMessageId: "root", actorOpenId: "u1", text, mentionsBot: true, isRootMessage: false });
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
const defaultBindingCard = { conversationKey: "binding:binding-default", bindingId: "binding-default", bindingGeneration: 1 };

function setup(adminOpenIds: readonly string[] = ["u1"]) {
  store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding-default", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-default", rootMessageId: "root", title: "default" });
  store.updateBinding("binding-default", { paneId: "w1:primary-default", state: "active", lifecycle: "active", attachment: "attached" });
  const create = (id: string, role: "primary" | "worker", projectId = "p1", bindingId = "binding-default", paneId = `w1:primary-${bindingId}`) => store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null, ...(role === "worker" ? { parent: { bindingId, paneId: bindingId === "binding-default" ? "w1:primary-default" : paneId, nativeSessionId: null }, workerSessionLifecycle: "active" as const } : {}), desiredState: "stopped", workspace: { id: `ws-${id}`, kind: role === "primary" ? "main-checkout" : "shared-read-only", cwd: projectId === "p1" ? "/repo" : "/repo-two", branch: null, baseCommit: "base" } });
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const messaging = { submit: vi.fn(async () => ({ accepted: true })), steer: vi.fn(), interrupt: vi.fn(), inspect: vi.fn() };
  const control = {
    listWorkers: (projectId: string) => store!.listAgentInstances(projectId).filter(({ role }) => role === "worker"),
    listWorkersForParent: (parent: { bindingId: string; paneId: string }) => store!.listWorkerInstancesByParent(parent),
    inspect: (id: string) => { const instance = store!.getAgentInstance(id)!; return { instance, workspace: store!.getWorkspaceLease(instance.workspaceLeaseId)! }; },
    createWorker: vi.fn(async (input) => { const binding = store!.getBinding(input.bindingId)!; return { status: "created" as const, instance: create(input.name, "worker", input.projectId, binding.id, binding.paneId!) }; }), start: vi.fn(), stop: vi.fn(),
    planRemoval: vi.fn(async ({ instanceId }) => { const instance = store!.getAgentInstance(instanceId)!; const workspace = store!.getWorkspaceLease(instance.workspaceLeaseId)!; return store!.createInstanceRemovalPlan({ id: "plan-1", instanceId, instanceGeneration: instance.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: "clean-fp", safe: true, reason: "clean", state: "pending", createdAt: "now" }); }),
    confirmRemoval: vi.fn(async () => true)
  };
  let interaction = 0;
  const workflow = new InstanceInteractionWorkflow({ projects: [project, secondProject], adminOpenIds, store, control: control as never, messaging: messaging as never, drivers: { describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }) } as never, outbound: outbound as never, presentation: applicationPresentation, idFactory: () => `interaction-${++interaction}` });
  return { create, workflow, outbound, messaging, control };
}

function taskCard(instanceId: string, state: "queued" | "running" | "completed" | "failed" | "cancelled" | "dispatch-uncertain", turnId = `turn-${state}`) {
  const worker = store!.getAgentInstance(instanceId)!;
  const view = createQueuedWorkerTurnCard({ turnId, instanceId, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
  store!.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: worker.projectId, instanceId, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: `source-${turnId}`, view, card: renderWorkerTurnCard(view) });
  store!.markOutboundReplyDelivered(store!.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === turnId)!.id, `card-message-${turnId}`, `card-${turnId}`);
  if (state !== "queued") {
    const occurredAt = "2026-09-01T00:01:00.000Z";
    const change = state === "running" ? { type: "running" as const, occurredAt }
      : state === "completed" ? { type: "completed" as const, occurredAt, answer: "done" }
      : { type: state, occurredAt, notice: `${state} notice` } as const;
    store!.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: worker.generation, state, eventKind: `turn.${state}`, change, render: renderWorkerTurnCard });
  }
  return { turnId, cardMessageId: `card-message-${turnId}` };
}

describe("instance routing", () => {
  it("routes a direct reply to the exact active Worker turn as steering", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, "running");
    vi.mocked(messaging.steer).mockResolvedValue({ status: "delivered" });

    await expect(workflow.handleOrdinaryMessage({ ...message("focus on transactions", "reply-1"), parentMessageId: task.cardMessageId })).resolves.toBe(true);

    expect(messaging.steer).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: worker.id, targetTurnId: task.turnId, text: "focus on transactions" }));
    expect(messaging.submit).not.toHaveBeenCalled();
  });

  it("uses the shared task policy to reject blocked and preparing direct replies", async () => {
    const { create, workflow, messaging, outbound } = setup();
    const worker = create("reviewer", "worker");
    const blocked = taskCard(worker.id, "running", "turn-blocked");
    store!.transitionInstanceTurnWithProjection({ turnId: blocked.turnId, expectedGeneration: worker.generation, state: "blocked", eventKind: "turn.blocked", change: { type: "blocked", occurredAt: "2026-09-01T00:02:00.000Z", notice: "local approval" }, render: renderWorkerTurnCard });
    await workflow.handleOrdinaryMessage({ ...message("more context", "reply-blocked"), parentMessageId: blocked.cardMessageId });
    expect(messaging.steer).not.toHaveBeenCalled();
    expect(JSON.stringify(outbound.enqueueCard.mock.calls.at(-1)?.[2])).toContain("对应 Pane");

    const preparing = taskCard(worker.id, "queued", "turn-preparing");
    store!.transitionInstanceTurnWithProjection({ turnId: preparing.turnId, expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching", change: { type: "preparing", occurredAt: "2026-09-01T00:03:00.000Z" }, render: renderWorkerTurnCard });
    await workflow.handleOrdinaryMessage({ ...message("do not guess", "reply-preparing"), parentMessageId: preparing.cardMessageId });
    expect(messaging.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(outbound.enqueueCard.mock.calls.at(-1)?.[2])).toContain("准备");
  });

  it("rejects a direct reply to a Task Card from an old Worker generation", async () => {
    const { create, workflow, messaging, outbound } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, "completed", "turn-old-generation");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: worker.generation, herdrWorkspaceId: "w1", paneId: "w1:replacement", nativeSessionId: "replacement" });

    await expect(workflow.handleOrdinaryMessage({ ...message("continue old work", "reply-old-generation"), parentMessageId: task.cardMessageId })).resolves.toBe(true);

    expect(messaging.submit).not.toHaveBeenCalled();
    expect(messaging.steer).not.toHaveBeenCalled();
    expect(JSON.stringify(outbound.enqueueCard.mock.calls.at(-1)?.[2])).toContain("过期");
  });

  it.each(["completed", "failed", "cancelled"] as const)("routes a direct reply to a %s Worker card as a follow-up", async (state) => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, state);

    await expect(workflow.handleOrdinaryMessage({ ...message("check the fix", `reply-${state}`), parentMessageId: task.cardMessageId })).resolves.toBe(true);

    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: worker.id, content: { kind: "followup", text: "check the fix" }, source: { messageId: `reply-${state}`, rootMessageId: "root", parentTurnId: task.turnId } }));
    expect(messaging.steer).not.toHaveBeenCalled();
  });

  it.each(["queued", "dispatch-uncertain"] as const)("rejects a direct reply to a %s Worker card without guessing another target", async (state) => {
    const { create, workflow, messaging, outbound } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, state);

    await expect(workflow.handleOrdinaryMessage({ ...message("do not reroute", `reply-${state}`), parentMessageId: task.cardMessageId })).resolves.toBe(true);

    expect(messaging.submit).not.toHaveBeenCalled();
    expect(messaging.steer).not.toHaveBeenCalled();
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain(state === "queued" ? "排队" : "无法确认");
  });

  it("opens and submits an exact-turn supplement from a running Task Card", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker"); const task = taskCard(worker.id, "running", "turn-action-running");
    vi.mocked(messaging.steer).mockResolvedValue({ status: "delivered", durableResult: true });
    const card = renderWorkerTurnCard(store!.loadWorkerTurnCard(task.turnId)!);
    const open = callbackValue(card, "worker_task_instruction_form");
    const form = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const submit = callbackValue(form, "worker_task_instruction_submit");

    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "focus transactions" } })).resolves.toEqual({ toast: { type: "success", content: "已补充到 reviewer 的当前任务。" } });
    expect(messaging.steer).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: worker.id, targetTurnId: task.turnId, text: "focus transactions" }));
    expect(messaging.submit).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"] as const)("creates one explicit follow-up from a %s Task Card action", async (state) => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker"); const task = taskCard(worker.id, state, `turn-action-${state}`);
    vi.mocked(messaging.submit).mockResolvedValue({ accepted: true, inserted: true, card: { queuePosition: 2 } } as never);
    const open = callbackValue(renderWorkerTurnCard(store!.loadWorkerTurnCard(task.turnId)!), "worker_task_instruction_form");
    const form = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const submit = callbackValue(form, "worker_task_instruction_submit");

    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "verify again" } })).resolves.toEqual({ toast: { type: "success", content: "已创建 reviewer 的后续任务，当前排队位置 2。" } });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ content: { kind: "followup", text: "verify again" }, source: expect.objectContaining({ parentTurnId: task.turnId }) }));
  });

  it("rejects a Task Card form when the task changes from running to completed", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker"); const task = taskCard(worker.id, "running", "turn-action-race");
    const open = callbackValue(renderWorkerTurnCard(store!.loadWorkerTurnCard(task.turnId)!), "worker_task_instruction_form");
    const form = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const submit = callbackValue(form, "worker_task_instruction_submit");
    store!.transitionInstanceTurnWithProjection({ turnId: task.turnId, expectedGeneration: worker.generation, state: "completed", eventKind: "turn.completed", change: { type: "completed", occurredAt: "2026-09-01T00:02:00.000Z", answer: "done" }, render: renderWorkerTurnCard });

    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "late" } })).resolves.toEqual({ toast: { type: "warning", content: "任务状态已变化，请重新打开 Task Card 后再操作。" } });
    expect(messaging.steer).not.toHaveBeenCalled(); expect(messaging.submit).not.toHaveBeenCalled();
  });

  it("starts an independent FIFO task from an owned Worker Main Card", async () => {
    const { create, workflow, messaging } = setup(); let worker = create("reviewer", "worker");
    worker = store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "idle" })!;
    worker = store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: worker.generation, herdrWorkspaceId: "w1", paneId: "w1:worker", nativeSessionId: "session" })!;
    const main = createWorkerMainView({ workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration, parentBindingId: "binding-default", parentBindingGeneration: 1, parentPaneId: "w1:primary-default", workerName: worker.name, ownerName: "Primary", runtimeGeneration: worker.generation, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: "w1:worker", workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-01T00:00:00.000Z" });
    store!.saveWorkerMainView({ ...main, messageId: "worker-main-action", cardId: "card-main" });
    vi.mocked(messaging.submit).mockResolvedValue({ accepted: true, inserted: true, card: { queuePosition: 2 } } as never);
    const open = callbackValue(renderWorkerMainCard(store!.loadWorkerMainView(worker.id, worker.workerSessionGeneration)!), "worker_new_task_form");
    const form = await workflow.handleCardAction({ messageId: "worker-main-action", chatId: "chat", operatorOpenId: "u1", value: open });
    const submit = callbackValue(form, "worker_new_task_submit");

    await expect(workflow.handleCardAction({ messageId: "worker-main-action", chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { task_text: "new independent work" } })).resolves.toEqual({ toast: { type: "success", content: "已向 reviewer 发起新任务，当前排队位置 2。" } });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ content: { kind: "turn", text: "new independent work" }, source: expect.not.objectContaining({ parentTurnId: expect.anything() }) }));
  });

  it("deduplicates one form submission but gives a newly opened form a new interaction key", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker"); const task = taskCard(worker.id, "completed", "turn-repeat");
    vi.mocked(messaging.submit).mockResolvedValue({ accepted: true, inserted: true, card: { queuePosition: 1 } } as never);
    const open = callbackValue(renderWorkerTurnCard(store!.loadWorkerTurnCard(task.turnId)!), "worker_task_instruction_form");
    const firstForm = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const firstSubmit = callbackValue(firstForm, "worker_task_instruction_submit");
    await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: firstSubmit, formValues: { instruction_text: "first follow-up" } });
    await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: firstSubmit, formValues: { instruction_text: "first follow-up" } });
    const secondForm = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const secondSubmit = callbackValue(secondForm, "worker_task_instruction_submit");
    await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: secondSubmit, formValues: { instruction_text: "second follow-up" } });

    const keys = vi.mocked(messaging.submit).mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys).toEqual(["card:interaction-1:task-followup:turn-repeat", "card:interaction-1:task-followup:turn-repeat", "card:interaction-2:task-followup:turn-repeat"]);
  });

  it("gives each Worker Main new-task form its own idempotency scope", async () => {
    const { create, workflow, messaging } = setup(); let worker = create("reviewer", "worker");
    worker = store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "idle" })!;
    worker = store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: worker.generation, herdrWorkspaceId: "w1", paneId: "w1:worker", nativeSessionId: "session" })!;
    const main = createWorkerMainView({ workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration, parentBindingId: "binding-default", parentBindingGeneration: 1, parentPaneId: "w1:primary-default", workerName: worker.name, ownerName: "Primary", runtimeGeneration: worker.generation, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: "w1:worker", workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-01T00:00:00.000Z" });
    store!.saveWorkerMainView({ ...main, messageId: "worker-main-repeat", cardId: "card-main-repeat" });
    vi.mocked(messaging.submit).mockResolvedValue({ accepted: true, inserted: true, card: { queuePosition: 1 } } as never);
    const open = callbackValue(renderWorkerMainCard(store!.loadWorkerMainView(worker.id, worker.workerSessionGeneration)!), "worker_new_task_form");
    const first = callbackValue(await workflow.handleCardAction({ messageId: "worker-main-repeat", chatId: "chat", operatorOpenId: "u1", value: open }), "worker_new_task_submit");
    const second = callbackValue(await workflow.handleCardAction({ messageId: "worker-main-repeat", chatId: "chat", operatorOpenId: "u1", value: open }), "worker_new_task_submit");
    await workflow.handleCardAction({ messageId: "worker-main-repeat", chatId: "chat", operatorOpenId: "u1", value: first, formValues: { task_text: "first task" } });
    await workflow.handleCardAction({ messageId: "worker-main-repeat", chatId: "chat", operatorOpenId: "u1", value: second, formValues: { task_text: "second task" } });

    expect(vi.mocked(messaging.submit).mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      `card:interaction-1:worker-new-task:${worker.id}`, `card:interaction-2:worker-new-task:${worker.id}`
    ]);
  });

  it("rejects empty, wrong-operator, stale-session, and stale-binding Worker forms", async () => {
    const { create, workflow, messaging } = setup(["u1", "u2"]);
    const worker = create("reviewer", "worker"); const task = taskCard(worker.id, "completed", "turn-fences");
    const open = callbackValue(renderWorkerTurnCard(store!.loadWorkerTurnCard(task.turnId)!), "worker_task_instruction_form");
    const form = await workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: open });
    const submit = callbackValue(form, "worker_task_instruction_submit");
    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u2", value: submit, formValues: { instruction_text: "forged" } })).resolves.toMatchObject({ toast: { type: "error" } });
    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "   " } })).resolves.toMatchObject({ toast: { type: "error" } });
    store!.database.prepare("UPDATE agent_instances SET worker_session_generation = worker_session_generation + 1 WHERE id = ?").run(worker.id);
    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "stale session" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    store!.database.prepare("UPDATE agent_instances SET worker_session_generation = worker_session_generation - 1 WHERE id = ?").run(worker.id);
    store!.updateBinding("binding-default", { generation: 2 });
    await expect(workflow.handleCardAction({ messageId: task.cardMessageId, chatId: "chat", operatorOpenId: "u1", value: submit, formValues: { instruction_text: "stale binding" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(messaging.submit).not.toHaveBeenCalled();
  });

  it("does not route an unmapped direct reply through the selected Worker", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker");
    store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "instance", instanceId: worker.id, expectedGeneration: worker.generation } });

    await expect(workflow.handleOrdinaryMessage({ ...message("unknown parent", "reply-unmapped"), parentMessageId: "not-a-worker-card" })).resolves.toBe(false);

    expect(messaging.submit).not.toHaveBeenCalled();
    expect(messaging.steer).not.toHaveBeenCalled();
  });

  it("ignores a direct Worker-card reply that does not mention the bot", async () => {
    const { create, workflow, messaging } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, "running");

    await expect(workflow.handleOrdinaryMessage({ ...message("side conversation", "reply-no-mention"), parentMessageId: task.cardMessageId, mentionsBot: false })).resolves.toBe(false);

    expect(messaging.submit).not.toHaveBeenCalled();
    expect(messaging.steer).not.toHaveBeenCalled();
  });
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
    store!.updateBinding("binding-1", { paneId: "w1:primary-one", state: "active", lifecycle: "active", attachment: "attached" });
    store!.updateBinding("binding-2", { paneId: "w1:primary-two", state: "active", lifecycle: "active", attachment: "attached" });
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-1", "w1:primary-one", first.id);
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-2", "w1:primary-two", second.id);

    await workflow.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: first.id, generation: first.generation, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 1 } });
    await workflow.handleCardAction({ messageId: "card-2", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_set_target", instanceId: second.id, generation: second.generation, conversationKey: "binding:binding-2", bindingId: "binding-2", bindingGeneration: 1 } });

    expect(store!.getConversationTarget("binding:binding-1")?.target).toMatchObject({ kind: "instance", instanceId: first.id });
    expect(store!.getConversationTarget("binding:binding-2")?.target).toMatchObject({ kind: "instance", instanceId: second.id });
  });

  it("rejects create and open callbacks from a stale binding generation", async () => {
    const { create, workflow, control } = setup(["u1", "u2"]);
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
    store!.updateBinding("binding-1", { paneId: "w1:primary-one", state: "active", lifecycle: "active", attachment: "attached", generation: 3 });
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-1", "w1:primary-one", worker.id);
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
    await workflow.handleCommand({ ...message("/project p1"), topicId: null, rootMessageId: "unbound-root" }, { kind: "project", projectId: "p1" });
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
    const { create, workflow, messaging, outbound } = setup(); create("worker", "worker");
    store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    await workflow.handleCommand(message("/to worker review", "m1"), { kind: "to", name: "worker", text: "review" });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root" } }));
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
    expect(store!.getConversationTarget("root:root")).toEqual({ projectId: "p1", target: { kind: "primary" } });
  });
  it("keeps explicit /to routing independent of the replied Worker card", async () => {
    const { create, workflow, messaging } = setup();
    const first = create("first", "worker");
    create("second", "worker");
    store!.setConversationTarget({ chatId: "root:root", projectId: "p1", target: { kind: "primary" } });
    const task = taskCard(first.id, "running");
    const explicit = { ...message("/to second new task", "explicit-to"), parentMessageId: task.cardMessageId };

    await workflow.handleCommand(explicit, { kind: "to", name: "second", text: "new task" });

    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "second", content: { kind: "turn", text: "new task" } }));
    expect(messaging.steer).not.toHaveBeenCalled();
  });
  it("routes the same Worker name only within the current Primary pane", async () => {
    const { workflow, messaging } = setup();
    store!.createPendingBinding({ id: "binding-sibling", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-sibling", rootMessageId: "root-sibling", title: "sibling" });
    store!.updateBinding("binding-sibling", { paneId: "w1:primary-sibling", state: "active", lifecycle: "active", attachment: "attached" });
    store!.createAgentInstance({ id: "reviewer-default", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "binding-default", paneId: "w1:primary-default", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "stopped", workspace: { id: "ws-reviewer-default", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store!.createAgentInstance({ id: "reviewer-sibling", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "binding-sibling", paneId: "w1:primary-sibling", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "stopped", workspace: { id: "ws-reviewer-sibling", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });

    await workflow.handleCommand(message("/to reviewer default", "to-default"), { kind: "to", name: "reviewer", text: "default" });
    await workflow.handleCommand({ ...message("/to reviewer sibling", "to-sibling"), topicId: "topic-sibling", rootMessageId: "root-sibling" }, { kind: "to", name: "reviewer", text: "sibling" });

    expect(messaging.submit.mock.calls.map(([input]) => input.targetInstanceId)).toEqual(["reviewer-default", "reviewer-sibling"]);
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
  it("opens only an owned durable Worker task view behind the current binding fence", async () => {
    const { create, workflow } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, "completed", "turn-history");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "Project / task" });
    store!.updateBinding("binding-1", { paneId: "w1:primary-one", state: "active", lifecycle: "active", attachment: "attached" });
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-1", "w1:primary-one", worker.id);
    const value = { action: "instance_turn_open", instanceId: worker.id, generation: worker.generation, turnId: task.turnId, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 1 };

    await expect(workflow.handleCardAction({ messageId: "history", chatId: "chat", operatorOpenId: "u1", value })).resolves.toMatchObject({ card: { header: { title: { content: "🎯 reviewer · Task turn-his" } } } });
    await expect(workflow.handleCardAction({ messageId: "history", chatId: "chat", operatorOpenId: "u1", value: { ...value, turnId: "missing" } })).resolves.toEqual({ toast: { type: "warning", content: "任务不存在或不属于当前 Worker。" } });
    await expect(workflow.handleCardAction({ messageId: "history", chatId: "chat", operatorOpenId: "u1", value: { ...value, bindingGeneration: 0 } })).resolves.toEqual({ toast: { type: "warning", content: "话题上下文已变化，请重新打开实例目录。" } });
  });
  it("opens durable Worker card targets by persisted ownership without requiring a conversation key", async () => {
    const { create, workflow } = setup();
    const worker = create("reviewer", "worker");
    const main = createWorkerMainView({
      workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration, parentBindingId: "binding-default", parentBindingGeneration: 1, parentPaneId: "w1:primary-default",
      workerName: worker.name, ownerName: "Primary", runtimeGeneration: worker.generation, runtimeState: worker.observedState, runtimeAttached: false, desiredState: worker.desiredState, parentActive: true, workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-05T00:00:00.000Z"
    });
    store!.saveWorkerMainView({ ...main, messageId: "worker-main-message", cardId: "worker-main-card" });
    const task = taskCard(worker.id, "completed", "owned-task");

    await expect(workflow.handleCardAction({ messageId: "source", chatId: "chat", operatorOpenId: "u1", value: { action: "card_target_open", aggregateKind: "worker-session", aggregateId: worker.id, generation: worker.workerSessionGeneration, messageId: "worker-main-message" } })).resolves.toMatchObject({ card: { header: { title: { content: "🤖 Worker · reviewer" } } } });
    await expect(workflow.handleCardAction({ messageId: "source", chatId: "chat", operatorOpenId: "u1", value: { action: "card_target_open", aggregateKind: "worker-turn", aggregateId: task.turnId, generation: worker.generation, messageId: task.cardMessageId } })).resolves.toMatchObject({ card: { header: { title: { content: "🎯 reviewer · Task owned-ta" } } } });
  });

  it("rejects stale and cross-Primary Worker card targets", async () => {
    const { create, workflow } = setup();
    const worker = create("reviewer", "worker");
    const task = taskCard(worker.id, "completed", "owned-task");
    store!.createPendingBinding({ id: "binding-other", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-other", rootMessageId: "root-other", title: "Other Primary" });
    store!.updateBinding("binding-other", { paneId: "w1:primary-other", state: "active", lifecycle: "active", attachment: "attached" });
    const target = { action: "card_target_open", aggregateKind: "worker-turn", aggregateId: task.turnId, generation: worker.generation, messageId: task.cardMessageId };

    await expect(workflow.handleCardAction({ messageId: "source", chatId: "chat", operatorOpenId: "u1", value: { ...target, messageId: "stale-message" } })).resolves.toEqual({ toast: { type: "warning", content: "Worker Task 卡片已过期或不属于当前 Primary。" } });
    await expect(workflow.handleCardAction({ messageId: "source", chatId: "chat", operatorOpenId: "u1", value: { ...target, generation: worker.generation + 1 } })).resolves.toEqual({ toast: { type: "warning", content: "Worker Task 卡片已过期或不属于当前 Primary。" } });
    await expect(workflow.handleCardAction({ messageId: "source", chatId: "chat", operatorOpenId: "u1", value: { ...target, conversationKey: "binding:binding-other", bindingId: "binding-other", bindingGeneration: 1 } })).resolves.toEqual({ toast: { type: "warning", content: "Worker Task 卡片已过期或不属于当前 Primary。" } });
  });
  it("creates a Worker only when the form submitter matches the operator who opened it", async () => {
    const { workflow, control } = setup(["u1", "u2"]);
    const form = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_form", projectId: "p1", ...defaultBindingCard } });
    expect(JSON.stringify(form)).toContain("instance_create_submit");
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u2", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1", ...defaultBindingCard }, formValues: { name: "reviewer", role: "worker", agent_kind: "traex", model: "", start: "false" } })).resolves.toEqual({ toast: { type: "error", content: "只有发起此操作的用户可以提交。" } });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1", ...defaultBindingCard }, formValues: { name: "reviewer", role: "primary", agent_kind: "traex", model: "", start: "false" } })).resolves.toMatchObject({ toast: { type: "success" } });
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
        value: { action: "instance_create_submit", projectId: "p1", requestedBy: "u1", ...defaultBindingCard },
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
    const opened = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_form", instanceId: worker.id, generation: worker.generation, ...defaultBindingCard } });
    expect(JSON.stringify(opened)).toContain("instance_steer_submit");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_steer_submit", instanceId: worker.id, generation: 1, requestedBy: "u1", ...defaultBindingCard }, formValues: { steer_text: "focus tests" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(messaging.steer).not.toHaveBeenCalled();
  });
  it("propagates a binding fence through steer form submission", async () => {
    const { create, workflow, messaging } = setup(); const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "one" });
    store!.updateBinding("binding-1", { paneId: "w1:primary-one", state: "active", lifecycle: "active", attachment: "attached", generation: 3 });
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-1", "w1:primary-one", worker.id);
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
    const planned = await workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_plan_removal", instanceId: worker.id, generation: worker.generation, ...defaultBindingCard } });
    expect(JSON.stringify(planned)).toContain("instance_confirm_removal");
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "p1", nativeSessionId: null });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: worker.id, generation: 1, planId: "plan-1", requestedBy: "u1", ...defaultBindingCard } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(control.confirmRemoval).not.toHaveBeenCalled();
    const current = store!.getAgentInstance(worker.id)!; const currentWorkspace = store!.getWorkspaceLease(current.workspaceLeaseId)!;
    store!.createInstanceRemovalPlan({ id: "dirty-plan", instanceId: current.id, instanceGeneration: current.generation, workspaceGeneration: currentWorkspace.generation, worktreeFingerprint: "dirty-fp", safe: false, reason: "dirty", state: "pending", createdAt: "now" });
    await expect(workflow.handleCardAction({ messageId: "card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: current.id, generation: current.generation, planId: "dirty-plan", requestedBy: "u1", ...defaultBindingCard } })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(control.confirmRemoval).not.toHaveBeenCalled();
  });
  it("confirms a safe removal only while the persisted evidence is current", async () => {
    const { create, workflow, control } = setup(); const worker = create("worker", "worker");
    await workflow.handleCardAction({ messageId: "plan-card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_plan_removal", instanceId: worker.id, generation: worker.generation, ...defaultBindingCard } });
    await expect(workflow.handleCardAction({ messageId: "confirm-card", chatId: "chat", operatorOpenId: "u1", value: { action: "instance_confirm_removal", instanceId: worker.id, generation: worker.generation, planId: "plan-1", requestedBy: "u1", ...defaultBindingCard } })).resolves.toEqual({ toast: { type: "success", content: "实例 worker 已删除。" } });
    expect(control.confirmRemoval).toHaveBeenCalledWith({ actor: { kind: "human", userId: "u1", channel: "feishu" }, planId: "plan-1" });
  });
  it("propagates a binding fence through removal confirmation", async () => {
    const { create, workflow, control } = setup(); const worker = create("worker", "worker");
    store!.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root", title: "one" });
    store!.updateBinding("binding-1", { paneId: "w1:primary-one", state: "active", lifecycle: "active", attachment: "attached", generation: 2 });
    store!.database.prepare("UPDATE agent_instances SET parent_binding_id = ?, parent_pane_id = ?, worker_session_lifecycle = 'active' WHERE id = ?").run("binding-1", "w1:primary-one", worker.id);
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
