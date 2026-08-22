import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { buildSpaceDirectoryGroups, SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("space directory command", () => {
  it("groups all panes, keeps empty spaces, and tolerates one failed workspace", async () => {
    const cards: object[] = [];
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
      async updateCard() {}
    };
    const listPanes = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "w2") throw new Error("workspace unavailable");
      return [
        { paneId: "w1:p2", workspaceId, cwd: "/work/alpha", label: "Zulu", agentState: "idle" as const, foregroundExecutables: ["bash"] },
        { paneId: "w1:p1", workspaceId, cwd: "/work/alpha-extra", label: "Alpha", agentState: "working" as const, foregroundExecutables: ["vim"] },
        { paneId: "w1:p3", workspaceId, cwd: "/tmp/unregistered", label: "Utility", agentState: "unknown" as const, foregroundExecutables: [] }
      ];
    });
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      listPanes,
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/work/alpha", executable: "herdr" },
      projects: [
        { id: "alpha", displayName: "Alpha", spaceName: "space-a", description: "A", workspaceId: "w1", cwd: "/work/alpha" },
        { id: "alpha-extra", displayName: "Alpha Extra", spaceName: "space-a", description: "A2", workspaceId: "w1", cwd: "/work/alpha-extra" },
        { id: "empty", displayName: "Empty", spaceName: "space-empty", description: "Empty", workspaceId: "w1", cwd: "/work/empty" },
        { id: "failed", displayName: "Failed", spaceName: "space-failed", description: "Failed", workspaceId: "w2", cwd: "/work/failed" }
      ],
      defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:",
      http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, logger);
    await coordinator.start();
    listPanes.mockClear();

    await coordinator.handleMessage({ eventId: "spaces-1", messageId: "message-1", chatId: "chat", topicId: "message-1", rootMessageId: "message-1", actorOpenId: "user", text: "/herdr spaces", mentionsBot: true, isRootMessage: true });

    const rendered = JSON.stringify(cards);
    expect(store.listBindings()).toEqual([]);
    expect(rendered).toContain("space\\\\-a");
    expect(rendered).toContain("space\\\\-empty");
    expect(rendered).toContain("space\\\\-failed");
    expect(rendered).toContain("未注册");
    expect(rendered).toContain("w1:p1");
    expect(rendered).toContain("w1:p2");
    expect(rendered).toContain("w1:p3");
    expect(rendered).toContain("workspace unavailable");
    expect(listPanes.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["w1", "w2"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "space-directory-workspace-failed", workspaceId: "w2" }), expect.any(String));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("merges projects sharing a space and workspace in configuration order", () => {
    const projects = [
      { id: "a", displayName: "A", spaceName: "shared", description: "A", workspaceId: "w1", cwd: "/a" },
      { id: "b", displayName: "B", spaceName: "shared", description: "B", workspaceId: "w1", cwd: "/b" },
      { id: "c", displayName: "C", spaceName: "later", description: "C", workspaceId: "w1", cwd: "/c" }
    ];
    const groups = buildSpaceDirectoryGroups(projects, new Map([["w1", []]]), new Map());
    expect(groups).toMatchObject([
      { spaceName: "shared", directories: ["/a", "/b"] },
      { spaceName: "later", directories: ["/c"] }
    ]);
  });
});
