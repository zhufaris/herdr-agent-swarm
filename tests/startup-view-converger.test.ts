import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { StartupViewConverger } from "../src/coordinator/startup-view-converger.js";
import { initialTopicView } from "../src/domain/topic-view.js";
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
});
