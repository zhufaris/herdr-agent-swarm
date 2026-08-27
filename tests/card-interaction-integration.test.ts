import { describe, expect, it, vi } from "vitest";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

function harness() {
  const store = new SqliteBindingStore(":memory:");
  const binding = store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
  store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active" });
  store.enqueuePrompt({ id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "member", body: "work" });
  store.updatePrompt("parent", "running");
  let active: { promptId: string; paneId: string } | null = { promptId: "parent", paneId: "w1:p1" };
  const steer = vi.fn(async () => true);
  const wakeSteering = vi.fn();
  const workflow = new CardInteractionWorkflow({ store, paneControl: { steer, stop: vi.fn(async () => true) }, sessionAdministration: { emitStatus: vi.fn(async () => {}), rename: vi.fn(async () => true), archive: vi.fn(async () => true), resume: vi.fn(async () => true) }, provisioning: { reset: vi.fn(async () => true), reattach: vi.fn(async () => {}), replace: vi.fn(async () => {}) }, paneClosure: { requestPaneClose: vi.fn(async () => true) }, modelSelection: { runModel: vi.fn(async () => true) }, activeTurn: () => active, wakeSteering });
  return { store, binding: store.getBinding("b1")!, workflow, steer, wakeSteering, end: () => { active = null; } };
}

describe("card interactions", () => {
  it("opens an operator-scoped supplement form and submits only to the captured turn", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_supplement", bindingId: "b1" } });
    expect(JSON.stringify(opened?.card)).toContain("supplement_text");
    const interactionId = findValue(opened!.card!, "submit_supplement").interactionId as string;
    const wrong = await h.workflow.handle({ messageId: "form", chatId: "chat", operatorOpenId: "other", value: { action: "submit_supplement", interactionId, bindingId: "b1", bindingGeneration: 1 }, formValues: { supplement_text: "more" } });
    expect(wrong?.toast?.type).toBe("error"); expect(h.steer).not.toHaveBeenCalled();
    const sent = await h.workflow.handle({ messageId: "form", chatId: "chat", operatorOpenId: "member", value: { action: "submit_supplement", interactionId, bindingId: "b1", bindingGeneration: 1 }, formValues: { supplement_text: "more" } });
    expect(sent?.toast?.type).toBe("success"); expect(h.steer).toHaveBeenCalledWith(expect.anything(), expect.anything(), "more", "parent");
    const duplicate = await h.workflow.handle({ messageId: "form", chatId: "chat", operatorOpenId: "member", value: { action: "submit_supplement", interactionId, bindingId: "b1", bindingGeneration: 1 }, formValues: { supplement_text: "more" } });
    expect(duplicate?.toast?.content).toContain("已处理"); expect(h.steer).toHaveBeenCalledTimes(1);
    h.store.close();
  });

  it("does not send a supplement after the captured parent turn ends", async () => {
    const h = harness();
    const opened = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_supplement", bindingId: "b1" } });
    const interactionId = findValue(opened!.card!, "submit_supplement").interactionId as string; h.end();
    const result = await h.workflow.handle({ messageId: "form", chatId: "chat", operatorOpenId: "member", value: { action: "submit_supplement", interactionId, bindingId: "b1", bindingGeneration: 1 }, formValues: { supplement_text: "late" } });
    expect(result?.toast?.type).toBe("warning"); expect(h.steer).not.toHaveBeenCalled(); h.store.close();
  });

  it("atomically converts a queued prompt and preserves it when the parent has ended", async () => {
    const h = harness();
    h.store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "queued-message", actorOpenId: "member", body: "follow-up" });
    const value = { action: "convert_queued_prompt", bindingId: "b1", targetPromptId: "queued" };
    const converted = await h.workflow.handle({ messageId: "answer", chatId: "chat", operatorOpenId: "member", value });
    expect(converted?.toast?.type).toBe("success"); expect(h.store.getPrompt("queued")).toMatchObject({ dispatchKind: "steering", parentPromptId: "parent" }); expect(h.wakeSteering).toHaveBeenCalledWith("b1", "parent");
    h.store.enqueuePrompt({ id: "queued-2", bindingId: "b1", larkMessageId: "queued-message-2", actorOpenId: "member", body: "later" }); h.end();
    const stale = await h.workflow.handle({ messageId: "answer-2", chatId: "chat", operatorOpenId: "member", value: { ...value, targetPromptId: "queued-2" } });
    expect(stale?.toast?.type).toBe("warning"); expect(h.store.getPrompt("queued-2")).toMatchObject({ dispatchKind: "turn", parentPromptId: null, state: "queued" }); h.store.close();
  });

  it("shows management controls only to the creator and rejects forged callbacks", async () => {
    const h = harness();
    const member = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(member?.card)).toContain("刷新状态"); expect(JSON.stringify(member?.card)).not.toContain("停止当前任务");
    const forged = await h.workflow.handle({ messageId: "more", chatId: "chat", operatorOpenId: "member", value: { action: "session_archive", bindingId: "b1", bindingGeneration: 1 } });
    expect(forged?.toast?.type).toBe("error");
    const creator = await h.workflow.handle({ messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(creator?.card)).toContain("停止当前任务"); expect(JSON.stringify(creator?.card)).toContain("关闭 Pane"); h.store.close();
  });
});

function findValue(card: object, action: string): Record<string, unknown> {
  const stack: unknown[] = [card];
  while (stack.length) { const item = stack.pop(); if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (record.value && typeof record.value === "object" && (record.value as Record<string, unknown>).action === action) return record.value as Record<string, unknown>; stack.push(...Object.values(record)); }
  throw new Error("action not found");
}
