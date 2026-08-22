import pino from "pino";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Herdr discovery", () => {
  it("uses the root card as the status card instead of posting a second card", async () => {
    let created = 0; let replied = 0; let updated = 0;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { created += 1; return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyCard() { replied += 1; return { messageId: "reply-1" }; },
      async updateCard() { updated += 1; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const stopProjector = new CardProjector(bus, store, lark, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, pino({ enabled: false }));
    await coordinator.start();

    expect({ created, replied, updated }).toEqual({ created: 1, replied: 0, updated: 2 });
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ statusMessageId: "root-1", state: "active" });

    await coordinator.stop(); stopProjector(); store.close();
  });
});
