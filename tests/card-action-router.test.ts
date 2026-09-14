import { describe, expect, it, vi } from "vitest";
import { CardActionRouter } from "../src/coordinator/card-action-router.js";
import { instanceCardActionNames, sessionCardActionNames } from "../src/coordinator/card-action-command.js";

function harness() {
  const cardInteractions = { handle: vi.fn(async () => ({ toast: { type: "success" as const, content: "session" } })) };
  const instanceInteractions = { handleCardAction: vi.fn(async () => ({ toast: { type: "success" as const, content: "instance" } })) };
  const modelSelection = { selectModel: vi.fn(async () => {}), selectModelMode: vi.fn(async () => {}) };
  const deliveryRecovery = { openThread: vi.fn(async () => {}), decideDeadLetter: vi.fn(async () => {}), forwardPaneThread: vi.fn(async () => "sent" as "sent" | "stale") };
  const provisioning = { attach: vi.fn(async () => true), completeSelection: vi.fn(async () => null) };
  const router = new CardActionRouter({
    chatId: "chat", allowedOpenIds: ["user"], adminOpenIds: ["user"],
    projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }],
    store: { getBinding: () => ({ chatId: "chat", creatorOpenId: "user" }) as never },
    provisioning: provisioning as never, cardInteractions, modelSelection: modelSelection as never, deliveryRecovery, instanceInteractions: instanceInteractions as never,
    logger: { info: vi.fn(), error: vi.fn() }, enqueueInitialPrompt: vi.fn(async () => {}),
  });

  return { router, cardInteractions, instanceInteractions, modelSelection, deliveryRecovery, provisioning };
}

const action = (value: unknown, option?: string) => ({ messageId: "card", chatId: "chat", operatorOpenId: "user", value, ...(option ? { option } : {}) });

describe("card action router", () => {
  it("waits for every admitted callback and rejects work after the shutdown gate", async () => {
    const h = harness();
    let release!: () => void;
    h.instanceInteractions.handleCardAction.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ toast: { type: "success", content: "done" } }); }));
    const running = h.router.handle(action(validPayload("instance_start")));
    await vi.waitFor(() => expect(h.instanceInteractions.handleCardAction).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = h.router.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    await expect(h.router.handle(action(validPayload("instance_stop")))).resolves.toEqual({ toast: { type: "warning", content: "该操作已失效，请刷新卡片后重试。" } });
    expect(h.instanceInteractions.handleCardAction).toHaveBeenCalledOnce();
    release();
    await Promise.all([running, stopping]);
    expect(stopped).toBe(true);
  });

  it("reports exact Primary and Worker canonical forwarding outcomes", async () => {
    const h = harness();
    await expect(h.router.handle(action({ action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: 1, paneId: "pane-1", sourceMainMessageId: "om-main" }))).resolves.toEqual({ toast: { type: "success", content: "已将原始 Primary Thread 发送到群底部。" } });
    await expect(h.router.handle(action({ action: "pane_worker_thread_forward", instanceId: "i1", generation: 4, workerSessionGeneration: 3, bindingId: "b1", bindingGeneration: 1, parentPaneId: "pane-1", sourceMainMessageId: "om-main" }))).resolves.toEqual({ toast: { type: "success", content: "已将原始 Worker Thread 发送到群底部。" } });
    h.deliveryRecovery.forwardPaneThread.mockResolvedValueOnce("stale");
    await expect(h.router.handle(action({ action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: 1, paneId: "pane-1", sourceMainMessageId: "om-main" }))).resolves.toEqual({ toast: { type: "warning", content: "该 Thread 尚未就绪或已失效，请刷新 `/swarm panes` 后重试。" } });
  });

  it.each([
    ...instanceCardActionNames.map((name) => [name, validPayload(name), undefined, "instance"] as const),
    ...sessionCardActionNames.map((name) => [name, validPayload(name), undefined, "session"] as const),
    ["select_model", { action: "select_model", bindingId: "b1" }, "gpt-5.4", "model"],
    ["select_model_mode", { action: "select_model_mode", bindingId: "b1", operationId: "op1" }, "high", "model-mode"],
    ["open_project_thread", { action: "open_project_thread", bindingId: "b1" }, undefined, "open-thread"],
    ["retry_dead_letter", { action: "retry_dead_letter", replyId: "r1" }, undefined, "dead-letter"],
    ["dismiss_dead_letter", { action: "dismiss_dead_letter", replyId: "r1" }, undefined, "dead-letter"],
    ["select_project", { action: "select_project", selectionId: "s1", projectId: "p1" }, undefined, "project-selection"],
    ["claim_pane", { action: "claim_pane", projectId: "p1", workspaceId: "w1", paneId: "pane-1" }, undefined, "pane-claim"],
    ["pane_primary_thread_forward", { action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: 1, paneId: "pane-1", sourceMainMessageId: "om-main" }, undefined, "pane-directory"],
    ["pane_worker_thread_forward", { action: "pane_worker_thread_forward", instanceId: "i1", generation: 4, workerSessionGeneration: 3, bindingId: "b1", bindingGeneration: 1, parentPaneId: "pane-1", sourceMainMessageId: "om-main" }, undefined, "pane-directory"],
  ] as const)("dispatches %s to exactly one owner", async (_name, value, option, owner) => {
    const h = harness();
    await h.router.handle(action(value, option));
    const owners = {
      instance: h.instanceInteractions.handleCardAction,
      session: h.cardInteractions.handle,
      model: h.modelSelection.selectModel,
      "model-mode": h.modelSelection.selectModelMode,
      "open-thread": h.deliveryRecovery.openThread,
      "dead-letter": h.deliveryRecovery.decideDeadLetter,
      "project-selection": h.provisioning.completeSelection,
      "pane-claim": h.provisioning.attach,
      "pane-directory": h.deliveryRecovery.forwardPaneThread,
    };
    expect(owners[owner]).toHaveBeenCalledOnce();
    expect(Object.values(owners).reduce((count, mock) => count + mock.mock.calls.length, 0)).toBe(1);
    await h.router.stop();
  });

  it("keeps retired callbacks side-effect free and preserves their guidance", async () => {
    const h = harness();
    await expect(h.router.handle(action({ action: "open_supplement", bindingId: "b1" }))).resolves.toEqual({ toast: { type: "warning", content: "当前 Agent 不支持立即补充；请将内容作为普通消息发送。" } });
    await expect(h.router.handle(action({ action: "convert_queued_prompt", bindingId: "b1" }))).resolves.toEqual({ toast: { type: "warning", content: "该操作已失效，请刷新卡片后重试。" } });
    expect(h.cardInteractions.handle).not.toHaveBeenCalled();
    expect(h.instanceInteractions.handleCardAction).not.toHaveBeenCalled();
    expect(h.provisioning.attach).not.toHaveBeenCalled();
  });

  it("returns one generic stale response for unknown and malformed callbacks", async () => {
    const h = harness();
    const expected = { toast: { type: "warning", content: "该操作已失效，请刷新卡片后重试。" } };
    await expect(h.router.handle(action({ action: "future_action" }))).resolves.toEqual(expected);
    await expect(h.router.handle(action({ action: "select_model", bindingId: "b1" }))).resolves.toEqual(expected);
    expect(h.cardInteractions.handle).not.toHaveBeenCalled();
    expect(h.instanceInteractions.handleCardAction).not.toHaveBeenCalled();
  });
});

function validPayload(action: typeof instanceCardActionNames[number] | typeof sessionCardActionNames[number]): Record<string, unknown> {
  const binding = { bindingId: "b1", bindingGeneration: 1 };
  if (action === "create_new_task") return { action };
  if (action === "primary_continue_form") return { action, ...binding, parentPromptId: "prompt-1", sourceAnswerMessageId: "answer-1" };
  if (action === "primary_continue_submit") return { action, ...binding, interactionId: "interaction-1", parentPromptId: "prompt-1", sourceAnswerMessageId: "answer-1", requestedBy: "user" };
  if ((sessionCardActionNames as readonly string[]).includes(action)) return { action, ...binding, ...(["open_rename", "open_reattach", "submit_rename", "submit_reattach", "session_stop", "session_model", "session_reset", "session_archive", "session_replace", "session_resume", "session_pane_close"].includes(action) ? { interactionId: "interaction-1" } : {}) };
  if (action === "card_target_open") return { action, aggregateKind: "worker-turn", aggregateId: "turn-1", generation: 1, messageId: "card-1" };
  if (action === "primary_worker_create_submit") return { action, ...binding, conversationKey: "binding:b1" };
  if (action === "instance_create_form" || action === "instance_create_submit") return { action, projectId: "p1", ...(action.endsWith("submit") ? { requestedBy: "user" } : {}) };
  if (action === "worker_thread_send") return { action, instanceId: "i1", generation: 1, workerSessionGeneration: 1 };
  if (action.startsWith("worker_new_task_")) return { action, instanceId: "i1", generation: 1, workerSessionGeneration: 1, sourceCardMessageId: "card-1", ...(action.endsWith("submit") ? { interactionId: "interaction-1", requestedBy: "user" } : {}) };
  if (action.startsWith("worker_task_")) return { action, turnId: "turn-1", instanceId: "i1", generation: 1, workerSessionGeneration: 1, sourceCardMessageId: "card-1", ...(action.endsWith("submit") ? { interactionId: "interaction-1", requestedBy: "user", intent: "steer" } : {}) };
  return { action, instanceId: "i1", generation: 1, ...(action === "instance_turn_open" ? { turnId: "turn-1" } : {}), ...(action === "instance_steer_submit" ? { requestedBy: "user" } : {}), ...(action === "instance_confirm_removal" ? { requestedBy: "user", planId: "plan-1" } : {}) };
}
