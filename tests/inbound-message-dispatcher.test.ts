import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { DurableInboundPipeline } from "../src/coordinator/durable-inbound-pipeline.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

const authorizationMessage = {
  eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "message-1",
  actorOpenId: "ou_member", text: "inspect this", mentionsBot: true, isRootMessage: true
};

function harness(allowedOpenIds = ["ou_member"]) {
  const store = {
    isBridgeMessage: vi.fn(() => false), recordInboundMessage: vi.fn(() => true), recoverProcessingInboundMessages: vi.fn(() => 0),
    claimNextInboundMessage: vi.fn(() => null), markInboundMessageAccepted: vi.fn(), releaseInboundMessage: vi.fn()
  };
  const inboundWork = { subscribe: vi.fn(() => () => {}), notify: vi.fn(async () => undefined) };
  const router = { route: vi.fn(async () => ({ decision: "prompt", disposition: "prompt_queued" as const })) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { pipeline: new DurableInboundPipeline({ chatId: "chat", allowedOpenIds, store, router, inboundWork, logger } as never), store, router, inboundWork, logger };
}

describe("DurableInboundPipeline admission", () => {
  it("persists only a compact marker and emits a content-free hint for oversized input", async () => {
    const h = harness();
    const oversized = { ...authorizationMessage, text: "x".repeat(12_001) };

    await h.pipeline.receive(oversized);

    expect(h.store.recordInboundMessage).toHaveBeenCalledWith({ ...oversized, text: "", inputTooLarge: true });
    expect(h.inboundWork.notify).toHaveBeenCalledWith(expect.objectContaining({ payload: { eventId: oversized.eventId } }));
    expect(JSON.stringify(h.inboundWork.notify.mock.calls)).not.toContain(oversized.text);
  });

  it("does not persist a message from an unapproved group member", async () => {
    const h = harness(["ou_allowed"]);
    await h.pipeline.receive(authorizationMessage);
    expect(h.store.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.inboundWork.notify).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ actorOpenId: "ou_member", reason: "actor_not_allowed" }), expect.any(String));
  });

  it("persists work only once for an explicitly approved member", async () => {
    const h = harness();
    await h.pipeline.receive(authorizationMessage);
    expect(h.store.recordInboundMessage).toHaveBeenCalledWith(authorizationMessage);
  });
});

describe("DurableInboundPipeline durable FIFO", () => {
  it("loads the compact oversized marker from SQLite and terminally accepts its route", async () => {
    const store = new SqliteBindingStore(":memory:");
    const inboundWork = new InProcessInboundWorkNotifier();
    const route = vi.fn(async () => ({ decision: "input-too-large", disposition: "rejected" as const }));
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store, router: { route }, inboundWork, logger: pino({ enabled: false }) });
    try {
      pipeline.start();
      await pipeline.receive(message("oversized", "x".repeat(12_001)));
      await vi.waitFor(() => expect(route).toHaveBeenCalledWith(expect.objectContaining({ eventId: "oversized", text: "", inputTooLarge: true })));
      const row = store.database.prepare("SELECT payload_json, state FROM inbound_messages WHERE event_id = ?").get("oversized") as { payload_json: string; state: string };
      expect(JSON.parse(row.payload_json)).toMatchObject({ text: "", inputTooLarge: true });
      expect(row.state).toBe("accepted");
    } finally { await pipeline.stop(); store.close(); }
  });

  it("continues an independent scope when an earlier scope is retryable", async () => {
    const store = new SqliteBindingStore(":memory:");
    const accepted: string[] = [];
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => {
      if (input.eventId === "a-stopped-worker") throw new Error("Target instance is not running");
      accepted.push(input.eventId); return { decision: "test", disposition: "command_completed" as const };
    }) };
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store, router, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    try {
      store.recordInboundMessage({ ...message("a-stopped-worker", "hi"), rootMessageId: "stopped-worker-root" });
      store.recordInboundMessage({ ...message("b-later-stopped-worker", "later"), rootMessageId: "stopped-worker-root" });
      store.recordInboundMessage({ ...message("z-new", "/swarm new"), rootMessageId: "new-root" });
      pipeline.start();
      await vi.waitFor(() => expect(accepted).toEqual(["z-new"]));
      expect(store.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY event_id").all()).toEqual([
        { event_id: "a-stopped-worker", state: "received", error: "Target instance is not running" },
        { event_id: "b-later-stopped-worker", state: "received", error: null },
        { event_id: "z-new", state: "accepted", error: null }
      ]);
      expect(pipeline.snapshot()).toMatchObject({ state: "retry_wait", retryAttempt: 1 });
    } finally { await pipeline.stop(); store.close(); }
  });

  it("accepts a durable rejection result and continues the FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    const routed: string[] = [];
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => { routed.push(input.eventId); return { decision: "test", disposition: input.eventId === "rejected" ? "rejected" as const : "command_completed" as const }; }) };
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store, router, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    try {
      store.recordInboundMessage(message("rejected", "bad target"));
      store.recordInboundMessage(message("next", "/instances"));
      pipeline.start();
      await vi.waitFor(() => expect(routed).toHaveLength(2));
      expect(new Set(routed)).toEqual(new Set(["next", "rejected"]));
      expect(store.database.prepare("SELECT state FROM inbound_messages ORDER BY event_id").all()).toEqual([{ state: "accepted" }, { state: "accepted" }]);
    } finally { await pipeline.stop(); store.close(); }
  });

  it("waits for an executing route during shutdown and leaves no processing row", async () => {
    const store = new SqliteBindingStore(":memory:");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store, router: { route: async () => { await blocked; return { decision: "test", disposition: "command_completed" as const }; } }, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    pipeline.start();
    const receiving = pipeline.receive(message("shutdown", "work"));
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'shutdown'").get()).toEqual({ state: "processing" }));
    let stopped = false; const stopping = pipeline.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve)); expect(stopped).toBe(false);
    release(); await receiving; await stopping;
    expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'shutdown'").get()).toEqual({ state: "accepted" });
    store.close();
  });
});

function message(eventId: string, text: string) {
  return { eventId, messageId: `${eventId}-message`, parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: null, actorOpenId: "operator", text, mentionsBot: false, isRootMessage: true };
}
