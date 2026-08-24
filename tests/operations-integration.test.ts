import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("operational commands", () => {
  it("lists chat-scoped sessions and failures and retries only outbound delivery", async () => {
    let onAction: Parameters<LarkPort["start"]>[1];
    const cards: object[] = [];
    const updates: object[] = [];
    const replyCard = vi.fn(async (_root: string, card: object) => { cards.push(card); return { messageId: `card-${cards.length}` }; });
    const lark: LarkPort = {
      async start(_message, action) { onAction = action; }, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; }, async replyText() { return { messageId: "text" }; },
      replyCard, async shareThread() { return { messageId: "shared" }; }, async updateCard(_id, card) { updates.push(card); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("unused"); },
      async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root", title: "Visible" });
    store.createPendingBinding({ id: "b2", workspaceId: "w1", chatId: "other", topicId: "t2", rootMessageId: "other-root", title: "Hidden" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "prompt-message", actorOpenId: "u1", body: "must not replay" });
    store.updatePrompt("p1", "failed", "run failed");
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "failed-output", bindingId: "b1", promptId: "p1", rootMessageId: "root", kind: "card_reply", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(message(1, "/herdr sessions"));
    expect(JSON.stringify(cards.at(-1))).toContain("Visible");
    expect(JSON.stringify(cards.at(-1))).not.toContain("Hidden");
    await coordinator.handleMessage(message(2, "/herdr failures"));
    const failureCard = cards.at(-1)!;
    expect(JSON.stringify(failureCard)).toContain("retry_dead_letter");
    const value = findAction(failureCard, "retry_dead_letter");
    await onAction!({ messageId: "failure-card", chatId: "chat", operatorOpenId: "u1", value });

    expect(replyCard).toHaveBeenCalledWith("root", {}, "failed-output");
    expect(store.getOperationalSummary().prompts.failed).toBe(1);
    expect(store.countPendingPrompts("b1")).toBe(0);
    expect(JSON.stringify(updates.at(-1))).toContain("不会重放 TraeX 任务");

    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function findAction(card: object, action: string): unknown {
  const serialized = JSON.stringify(card);
  const match = serialized.match(new RegExp(`\\"value\\":(\\{\\"action\\":\\"${action}\\",\\"replyId\\":\\"[^\\"]+\\"\\})`));
  if (!match?.[1]) throw new Error(`Missing action ${action}`);
  return JSON.parse(match[1].replaceAll('\\"', '"'));
}
function message(index: number, text: string) { return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: null, rootMessageId: `m${index}`, actorOpenId: "u1", text, mentionsBot: true, isRootMessage: true }; }
function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "project", displayName: "Project", spaceName: "space", description: "test", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "project", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, instanceLease: { ttlMs: 15_000, heartbeatMs: 5_000 }, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
