import { describe, expect, it, vi } from "vitest";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

function harness() {
  const store = new SqliteBindingStore(":memory:");
  const binding = store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
  store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
  store.enqueuePrompt({ id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "member", body: "work" });
  store.updatePrompt("parent", "running");
  const wakePrompt = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sessionOperations = { accept: vi.fn(() => "accepted" as const) };
  const workflow = new CardInteractionWorkflow({ store, sessionAdministration: { emitStatus: vi.fn(async () => {}) }, sessionOperations, wakePrompt, logger });
  return { store, binding: store.getBinding("b1")!, workflow, wakePrompt, logger, sessionOperations };
}

describe("card interactions", () => {
  it("rejects legacy supplement actions without touching the terminal", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_supplement", bindingId: "b1" } });
    expect(opened?.toast).toEqual({ type: "warning", content: "当前 Agent 不支持立即补充；请将内容作为普通消息发送。" });
    h.store.close();
  });

  it("rejects legacy queued-steering callbacks without changing FIFO state", async () => {
    const h = harness();
    h.store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "queued-message", actorOpenId: "member", body: "follow-up" });
    const value = { action: "convert_queued_prompt", bindingId: "b1", bindingGeneration: 1, parentPromptId: "parent", targetPromptId: "queued" };
    const converted = await h.workflow.handle({ messageId: "answer", chatId: "chat", operatorOpenId: "member", value });
    expect(converted?.toast).toEqual({ type: "warning", content: "当前 Agent 不支持立即补充；请将内容作为普通消息发送。" });
    expect(h.store.getPrompt("queued")).toMatchObject({ dispatchKind: "turn", parentPromptId: null });
    h.store.close();
  });

  it("shows management controls only to the creator and rejects forged callbacks", async () => {
    const h = harness();
    const member = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(member?.card)).toContain("刷新状态"); expect(JSON.stringify(member?.card)).not.toContain("停止当前任务");
    const forged = await h.workflow.handle({ messageId: "more", chatId: "chat", operatorOpenId: "member", value: { action: "session_archive", bindingId: "b1", bindingGeneration: 1 } });
    expect(forged?.toast?.type).toBe("error");
    const creator = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(creator?.card)).toContain("停止当前任务"); expect(JSON.stringify(creator?.card)).toContain("关闭 Pane"); expect(JSON.stringify(creator?.card)).not.toContain("模型"); h.store.close();
  });

  it("rejects a historical model callback without persisting Session work", async () => {
    const h = harness();
    const result = await h.workflow.handle({ messageId: "old-more", chatId: "chat", operatorOpenId: "creator", value: { action: "session_model", bindingId: "b1", bindingGeneration: 1, interactionId: "old" } });
    expect(result?.toast?.type).toBe("warning");
    expect(h.sessionOperations.accept).not.toHaveBeenCalled();
    h.store.close();
  });

  it("durably delegates mutating Session callbacks before external execution", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const rename = findValue(opened!.card!, "open_rename");

    const result = await h.workflow.handle({ messageId: "rename-card", chatId: "chat", operatorOpenId: "creator", value: { ...rename, action: "submit_rename" }, formValues: { title: "New title" } });

    expect(result?.toast).toEqual({ type: "success", content: "操作已受理。" });
    expect(h.sessionOperations.accept).toHaveBeenCalledWith(expect.objectContaining({ operatorOpenId: "creator" }), expect.objectContaining({ id: "b1" }), rename.interactionId, "rename", "New title");
    h.store.close();
  });

  it("rejects oversized Session form arguments before durable acceptance", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const rename = findValue(opened!.card!, "open_rename");

    const result = await h.workflow.handle({ messageId: "rename-card", chatId: "chat", operatorOpenId: "creator", value: { ...rename, action: "submit_rename" }, formValues: { title: "x".repeat(501) } });

    expect(result?.toast?.type).toBe("warning");
    expect(h.sessionOperations.accept).not.toHaveBeenCalled();
    h.store.close();
  });

  it("shows only recovery-safe controls for an orphaned binding", async () => {
    const h = harness();
    h.store.updateBinding("b1", { state: "orphaned", attachment: "orphaned" });

    const creator = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1" } });
    const creatorCard = JSON.stringify(creator?.card);
    expect(creatorCard).toContain("刷新状态");
    expect(creatorCard).toContain("重新连接 Pane");
    expect(creatorCard).toContain("创建替代 Pane");
    expect(creatorCard).toContain("归档");
    expect(creatorCard).not.toContain("停止当前任务");
    expect(creatorCard).not.toContain("模型");
    expect(creatorCard).not.toContain("重置会话");
    expect(creatorCard).not.toContain("关闭 Pane");

    const member = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(member?.card)).toContain("刷新状态");
    expect(JSON.stringify(member?.card)).not.toContain("重新连接 Pane");
    h.store.close();
  });

  it("converts rejected automatic steering once and wakes ordinary work only after commit", async () => {
    const h = harness();
    const view = createQueuedRunCard({ promptId: "failed-auto", bindingId: "b1", bindingGeneration: 1, title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "now" });
    h.store.acceptPrompt({ prompt: { id: "failed-auto", bindingId: "b1", larkMessageId: "auto-message", actorOpenId: "member", body: "继续", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view, rootMessageId: "root", answerCard: {} });
    h.store.failPrompt({ promptId: "failed-auto", error: "not working", occurredAt: new Date().toISOString(), steeringFailureKind: "rejected" });
    const value = { action: "enqueue_failed_steering", bindingId: "b1", bindingGeneration: 1, sourcePromptId: "failed-auto" };

    const converted = await h.workflow.handle({ messageId: "failed-card", chatId: "chat", operatorOpenId: "member", value });
    expect(converted?.toast).toEqual({ type: "success", content: "已作为新任务排队。" });
    const replacement = h.store.database.prepare("SELECT id FROM prompt_jobs WHERE source_prompt_id = 'failed-auto'").get() as { id: string };
    expect(h.store.getPrompt(replacement.id)).toMatchObject({ dispatchKind: "turn", steeringOrigin: null, sourcePromptId: "failed-auto", body: "继续" });
    expect(h.wakePrompt).toHaveBeenCalledTimes(1);
    expect(h.store.loadRunCard(replacement.id)).toMatchObject({ sessionTitle: "task" });
    expect(h.store.listPendingOutboundReplies().some((reply) => reply.promptId === replacement.id)).toBe(true);

    const duplicate = await h.workflow.handle({ messageId: "failed-card", chatId: "chat", operatorOpenId: "member", value });
    expect(duplicate?.toast).toEqual({ type: "success", content: "已作为新任务排队。" });
    expect(h.wakePrompt).toHaveBeenCalledTimes(1);
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE source_prompt_id = 'failed-auto'").get()).toEqual({ count: 1 });
    h.store.close();
  });

  it.each([
    { name: "uncertain automatic steering", steeringOrigin: "automatic" as const, failureKind: "uncertain" as const, operatorOpenId: "member", generation: 1, chatId: "chat" },
    { name: "rejected explicit steering", steeringOrigin: "explicit" as const, failureKind: "rejected" as const, operatorOpenId: "member", generation: 1, chatId: "chat" },
    { name: "rejected converted steering", steeringOrigin: "converted" as const, failureKind: "rejected" as const, operatorOpenId: "member", generation: 1, chatId: "chat" },
    { name: "a different actor", steeringOrigin: "automatic" as const, failureKind: "rejected" as const, operatorOpenId: "other", generation: 1, chatId: "chat" },
    { name: "a stale binding generation", steeringOrigin: "automatic" as const, failureKind: "rejected" as const, operatorOpenId: "member", generation: 2, chatId: "chat" },
    { name: "a different chat", steeringOrigin: "automatic" as const, failureKind: "rejected" as const, operatorOpenId: "member", generation: 1, chatId: "other-chat" }
  ])("does not convert $name through a forged callback", async ({ steeringOrigin, failureKind, operatorOpenId, generation, chatId }) => {
    const h = harness();
    const sourcePromptId = `failed-${steeringOrigin}-${failureKind}-${operatorOpenId}-${generation}`;
    const view = createQueuedRunCard({ promptId: sourcePromptId, bindingId: "b1", bindingGeneration: 1, title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "now" });
    h.store.acceptPrompt({ prompt: { id: sourcePromptId, bindingId: "b1", larkMessageId: `${sourcePromptId}-message`, actorOpenId: "member", body: "继续", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin }, view, rootMessageId: "root", answerCard: {} });
    h.store.failPrompt({ promptId: sourcePromptId, error: "delivery failed", occurredAt: new Date().toISOString(), steeringFailureKind: failureKind });

    const result = await h.workflow.handle({ messageId: `${sourcePromptId}-card`, chatId, operatorOpenId, value: { action: "enqueue_failed_steering", bindingId: "b1", bindingGeneration: generation, sourcePromptId } });

    expect(result?.toast?.type).toBe(operatorOpenId === "other" ? "error" : "warning");
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE source_prompt_id = ?").get(sourcePromptId)).toEqual({ count: 0 });
    expect(h.store.getCardInteraction(`failed-steering:${sourcePromptId}-card:${sourcePromptId}`)).toBeNull();
    expect(h.wakePrompt).not.toHaveBeenCalled();
    h.store.close();
  });
});

function findValue(card: object, action: string): Record<string, unknown> {
  const stack: unknown[] = [card];
  while (stack.length) { const item = stack.pop(); if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (record.value && typeof record.value === "object" && (record.value as Record<string, unknown>).action === action) return record.value as Record<string, unknown>; stack.push(...Object.values(record)); }
  throw new Error("action not found");
}
