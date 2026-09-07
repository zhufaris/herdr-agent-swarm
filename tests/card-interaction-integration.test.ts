import { describe, expect, it, vi } from "vitest";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";

function harness() {
  const store = new SqliteBindingStore(":memory:");
  const binding = store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
  store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
  store.enqueuePrompt({ id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "member", body: "work" });
  store.updatePrompt("parent", "running");
  const wakePrompt = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sessionOperations = { accept: vi.fn(() => "accepted" as const) };
  const workflow = new CardInteractionWorkflow({ store, adminOpenIds: ["creator"], sessionAdministration: { emitStatus: vi.fn(async () => {}) }, sessionOperations, wakePrompt, presentation: applicationPresentation, logger });
  return { store, binding: store.getBinding("b1")!, workflow, wakePrompt, logger, sessionOperations };
}

describe("card interactions", () => {
  it("rejects legacy supplement actions without touching the terminal", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_supplement", bindingId: "b1" } });
    expect(opened?.toast).toEqual({ type: "warning", content: "当前 Agent 不支持立即补充；请将内容作为普通消息发送。" });
    h.store.close();
  });

  it("rejects retired card actions without changing FIFO state", async () => {
    const h = harness();
    h.store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "queued-message", actorOpenId: "member", body: "follow-up" });
    const value = { action: "convert_queued_prompt", bindingId: "b1", bindingGeneration: 1, parentPromptId: "parent", targetPromptId: "queued" };
    const converted = await h.workflow.handle({ messageId: "answer", chatId: "chat", operatorOpenId: "member", value });
    expect(converted?.toast).toEqual({ type: "warning", content: "该操作已失效，请刷新卡片后重试。" });
    expect(h.store.getPrompt("queued")).toMatchObject({ state: "queued" });
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

});

function findValue(card: object, action: string): Record<string, unknown> {
  const stack: unknown[] = [card];
  while (stack.length) { const item = stack.pop(); if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (record.value && typeof record.value === "object" && (record.value as Record<string, unknown>).action === action) return record.value as Record<string, unknown>; stack.push(...Object.values(record)); }
  throw new Error("action not found");
}
