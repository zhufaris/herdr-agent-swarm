import { describe, expect, it, vi } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { workerPresentation } from "./helpers/presentation.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { WorkerTurnCardWorkflow } from "../src/coordinator/worker-turn-card-workflow.js";

describe("rich-text Answer workflow", () => {
  it("creates, updates, and terminalizes one Primary post through the durable outbox", async () => {
    const store = new SqliteBindingStore(":memory:");
    try {
      store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", paneToken: "abcd", state: "active", lifecycle: "active", attachment: "attached" });
      const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", paneToken: "abcd", requestText: "go", queuePosition: 1, occurredAt: "2026-09-27T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root-1", answerCard: {} });

      const create = store.listPendingOutboundReplies()[0]!;
      expect(create).toMatchObject({ kind: "text", intentKind: "rich-text-reply", idempotencyKey: "answer-post:p1:0" });
      expect(JSON.parse(create.payload).document.title).toBe("🤖 bridge · abcd");
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ deliveryMode: "rich_post", state: "creating", cardId: null })]);
      store.markOutboundReplyDelivered(create.id, "answer-1");
      expect(store.getActiveAnswerPage("p1")).toMatchObject({ messageId: "answer-1", cardId: null, deliveryMode: "rich_post" });

      const running = store.loadRunCard("p1")!;
      store.saveRunCard({ ...running, phase: "running", answer: "Hello **world**", timelineItems: [{ id: "message:1", sequence: 1, kind: "agent_message", markdown: "Hello **world**" }], progressEvents: [{ key: "plan:0", kind: "step", label: "实现正文", state: "active", occurredAt: "2026-09-27T00:00:01.000Z" }], viewVersion: running.viewVersion + 1 });
      const wake = vi.fn();
      const workflow = new AnswerPageWorkflow(store, wake, primaryPresentation);
      await workflow.converge("p1");
      const update = store.listPendingOutboundReplies()[0]!;
      expect(update).toMatchObject({ kind: "card_update", intentKind: "rich-text-update", rootMessageId: "answer-1" });
      expect(JSON.parse(update.payload)).toMatchObject({ pageState: "active", document: { markdown: expect.stringContaining("Hello **world**") } });
      expect(JSON.parse(update.payload).document.title).toBe("🤖 bridge · abcd");
      expect(JSON.parse(update.payload).document.markdown).toContain("📋 **任务 0/1**\n- ■ 实现正文");
      expect(JSON.parse(update.payload).document.markdown).toMatch(/💭$/u);
      store.markOutboundReplyDelivered(update.id, "answer-1");

      const live = store.loadRunCard("p1")!;
      store.saveRunCard({ ...live, phase: "completed", viewVersion: live.viewVersion + 1, finishedAt: "2026-09-27T00:01:00.000Z" });
      await workflow.converge("p1");
      const terminal = store.listPendingOutboundReplies()[0]!;
      expect(JSON.parse(terminal.payload)).toMatchObject({ pageState: "finished", terminal: true, document: { markdown: expect.stringContaining("📋 **任务 0/1**\n- ■ 实现正文") } });
      expect(JSON.parse(terminal.payload).document.markdown).not.toContain("💭");
      store.markOutboundReplyDelivered(terminal.id, "answer-1");
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ state: "finished", cardId: null })]);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("uses the same mutable post lifecycle for Worker answers", async () => {
    const store = new SqliteBindingStore(":memory:");
    try {
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Primary" });
      store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane", lastAgentState: "idle" });
      const created = store.createWorkerAgentInstance({ id: "worker-1", projectId: "p1", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "b1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" }, workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
      const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "worker-pane", paneToken: "wk9x", nativeSessionId: "worker-session" })!;
      const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-27T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: "worker-message", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: "worker-message", view, render: workerPresentation.workerTurn });
      const create = store.listPendingOutboundReplies()[0]!;
      expect(create).toMatchObject({ kind: "text", intentKind: "rich-text-reply", workerTurnId: "turn-1" });
      expect(JSON.parse(create.payload).document.title).toBe("🤖 p1 · wk9x · worker");
      store.markOutboundReplyDelivered(create.id, "worker-answer-1");

      store.applyInstanceTurnProjection({ turnId: "turn-1", expectedGeneration: worker.generation, change: { type: "output", occurredAt: "2026-09-27T00:00:01.000Z", answer: "Worker **answer**", progressEvents: [{ key: "plan:0", kind: "step", label: "检查实现", state: "done", occurredAt: "2026-09-27T00:00:01.000Z" }], timelineDeltas: [{ id: "message:1", sequence: 1, kind: "agent_message", markdown: "Worker **answer**" }] }, render: workerPresentation.workerTurn });
      const wake = vi.fn();
      await new WorkerTurnCardWorkflow(store, wake, workerPresentation).converge("turn-1");
      const update = store.listPendingOutboundReplies()[0]!;
      expect(update).toMatchObject({ kind: "card_update", intentKind: "rich-text-update", rootMessageId: "worker-answer-1" });
      expect(JSON.parse(update.payload).document.markdown).toContain("Worker **answer**");
      expect(JSON.parse(update.payload).document.title).toBe("🤖 p1 · wk9x · worker");
      expect(JSON.parse(update.payload).document.markdown).toContain("📋 **任务 1/1**\n- ✔ 检查实现");
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("freezes a full page before activating a continuation post", async () => {
    const store = new SqliteBindingStore(":memory:");
    try {
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-09-27T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root-1", answerCard: {} });
      store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1");
      const running = store.loadRunCard("p1")!;
      const markdown = "paragraph\n\n".repeat(80);
      store.saveRunCard({ ...running, phase: "running", answer: markdown, timelineItems: [{ id: "message:1", sequence: 1, kind: "agent_message", markdown }], viewVersion: running.viewVersion + 1 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation, undefined, { pageLimit: 240, answerStreamContent: primaryPresentation.answerStreamContent, renderAnswerStreamPage: primaryPresentation.answerStreamPage });
      await workflow.converge("p1");
      const pending = store.listPendingOutboundReplies();
      const freeze = pending.find(({ intentKind }) => intentKind === "rich-text-update")!;
      const continuation = pending.find(({ intentKind }) => intentKind === "rich-text-reply")!;
      expect(JSON.parse(freeze.payload)).toMatchObject({ pageState: "frozen", document: { markdown: expect.not.stringContaining("💭") } });
      expect(continuation).toMatchObject({ idempotencyKey: "answer-post:p1:1", rootMessageId: "root-1" });
      store.markOutboundReplyDelivered(freeze.id, "answer-1");
      store.markOutboundReplyDelivered(continuation.id, "answer-2");
      expect(store.listAnswerPages("p1")).toEqual([
        expect.objectContaining({ pageIndex: 0, state: "frozen", messageId: "answer-1" }),
        expect.objectContaining({ pageIndex: 1, state: "active", messageId: "answer-2", deliveryMode: "rich_post" })
      ]);
    } finally {
      store.close();
    }
  });
});
