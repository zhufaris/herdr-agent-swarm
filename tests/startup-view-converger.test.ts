import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { StartupViewConverger } from "../src/coordinator/startup-view-converger.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { OutboundIntentPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

const config = {
  projects: [{ id: "bridge", displayName: "Bridge", spaceName: "herdr-lark-bridge", description: "Bridge", workspaceId: "wH", cwd: "/work/bridge" }]
} as const satisfies Pick<BridgeConfig, "projects">;

describe("StartupViewConverger", () => {
  it("reprojects an existing root card using the durable binding title", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "herdr-lark-bridge / task-ab12"
    });
    store.updateBinding("b1", { paneId: "wH:p2H", statusMessageId: "root-card", state: "active" });
    store.saveTopicView({
      ...initialTopicView("b1"), title: "HerderSwarm: 已就绪", workspaceId: "wH", spaceName: "old-space", paneId: "wH:p2H", phase: "ready"
    });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const outbound = { enqueueCardUpdate } as Pick<OutboundIntentPort, "enqueueCardUpdate">;
    await new StartupViewConverger(config, store, outbound as OutboundIntentPort, { wake: () => {}, subscribe: () => () => {} }).converge();

    expect(store.loadTopicView("b1")).toMatchObject({
      title: "herdr-lark-bridge / task-ab12", spaceName: "herdr-lark-bridge", paneId: "wH:p2H"
    });
    expect(enqueueCardUpdate).toHaveBeenCalledWith(
      "b1",
      "root-card",
      expect.stringMatching(/^startup-root-card-reconcile:b1:/),
      expect.objectContaining({ header: expect.objectContaining({ title: { tag: "plain_text", content: "herdr-lark-bridge / task-ab12" } }) })
    );
    store.close();
  });

  it("preserves unresolved legacy workspace naming when that workspace has multiple projects", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "legacy", projectId: null, workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy task" });
    store.updateBinding("legacy", { paneId: "w1:p1", statusMessageId: "root-card", state: "active" });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const multiProjectConfig = { projects: [
      { id: "one", displayName: "One", spaceName: "one", description: "One", workspaceId: "w1", cwd: "/one" },
      { id: "two", displayName: "Two", spaceName: "two", description: "Two", workspaceId: "w1", cwd: "/two" }
    ] } as const satisfies Pick<BridgeConfig, "projects">;

    await new StartupViewConverger(multiProjectConfig, store, { enqueueCardUpdate } as OutboundIntentPort, { wake: () => {}, subscribe: () => () => {} }).converge();

    expect(store.loadTopicView("legacy")?.spaceName).toBe("legacy/unresolved");
    store.close();
  });

  it("rebuilds missing terminal stream intents from a durable completed run card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable answer", answerSegments: ["durable answer"], viewVersion: 3, answerDeliveredVersion: 1 });
    const outbound = { enqueueCardUpdate: vi.fn() } as unknown as OutboundIntentPort;

    await new StartupViewConverger(config, store, outbound, { wake: () => {}, subscribe: () => () => {} }).converge();

    const pending = store.listPendingOutboundReplies();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "stream_content", promptId: "p1", rootMessageId: "answer-card", viewVersion: 1 });
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({ content: expect.stringContaining("durable answer"), sequence: 1, pageIndex: 0 });
    store.close();
  });
});
