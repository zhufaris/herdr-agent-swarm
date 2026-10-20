import { describe, expect, it, vi } from "vitest";
import { ProjectionDeliveryRecoveryWatchdog } from "../src/coordinator/projection-delivery-recovery-watchdog.js";
import { parseTurnCardProjectionKey } from "../src/domain/turn-card-projection-key.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import { SqliteConversationSegmentStore } from "../src/store/sqlite/conversation-segment-store.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";

const logger = { warn: vi.fn(), debug: vi.fn() };

describe("unified Turn Card runtime wiring", () => {
  it("publishes post-commit segment revisions with immediate semantic boundaries", () => {
    const context = new SqliteContext(":memory:");
    new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    const seen: Array<{ segmentId: string; viewVersion: number; urgency: string; workClass?: string; committedVersion: number }> = [];
    store.setProjectionNotifier((notification) => {
      seen.push({ ...notification, committedVersion: store.getConversationSegment(notification.segmentId)!.viewVersion });
    });
    const human = store.projectCanonicalEvent({
      laneId: "lane", laneSequence: 1,
      event: { eventId: "human", agentKind: "traex", sessionId: "session", payload: { type: "human_message", message_id: "human", text: "hello" } },
      observedAt: "2026-10-07T00:00:00.000Z"
    });
    const segmentId = human.segmentId!;
    store.projectCanonicalEvent({
      laneId: "lane", laneSequence: 2,
      event: { eventId: "first", agentKind: "traex", sessionId: "session", payload: { type: "message" } },
      timelineDeltas: [{ kind: "agent_message", id: "message:first", sequence: 1, markdown: "first" }],
      workClass: "history",
      observedAt: "2026-10-07T00:00:00.100Z"
    });
    store.projectCanonicalEvent({
      laneId: "lane", laneSequence: 3,
      event: { eventId: "second", agentKind: "traex", sessionId: "session", payload: { type: "message" } },
      timelineDeltas: [{ kind: "agent_message", id: "message:second", sequence: 2, markdown: "second" }],
      observedAt: "2026-10-07T00:00:00.200Z"
    });
    store.projectCanonicalEvent({
      laneId: "lane", laneSequence: 4,
      event: { eventId: "compact", agentKind: "traex", sessionId: "session", payload: { type: "context_compacted" } },
      timelineDeltas: [{ kind: "status", id: "compact:1", sequence: 3, label: "Context compacted", state: "completed" }],
      observedAt: "2026-10-07T00:00:00.300Z"
    });

    expect(seen).toEqual([
      { segmentId, viewVersion: 1, urgency: "immediate", committedVersion: 1 },
      { segmentId, viewVersion: 2, urgency: "immediate", workClass: "history", committedVersion: 2 },
      { segmentId, viewVersion: 3, urgency: "trailing", committedVersion: 3 },
      { segmentId, viewVersion: 4, urgency: "immediate", committedVersion: 4 }
    ]);
    context.close();
  });

  it("recovers actionable unified rows and requested callbacks", async () => {
    const converged: string[] = [];
    const watchdog = new ProjectionDeliveryRecoveryWatchdog({
      store: { listRecoverablePrimaryAnswerPromptIds: () => [], listRecoverableWorkerTurnIds: () => [], listRecoverableConversationSegmentIds: () => ["segment:abc"] },
      answerPages: { converge: async () => undefined } as never,
      workerTurns: { converge: async () => undefined } as never,
      turnCards: { converge: async (id: string) => { converged.push(id); } }, logger
    });
    await watchdog.scan();
    expect(converged).toEqual(["segment:abc"]);
    await watchdog.requestTurnCard("segment:abc");
    await watchdog.stop();
  });

  it("carries historical work class through the asynchronous Turn Card scheduler", async () => {
    vi.useFakeTimers();
    const converge = vi.fn(async () => undefined);
    const projector = new ConversationViewProjector(
      {} as never, {} as never, {} as never, {} as never, logger as never,
      {} as never, {} as never, {} as never,
      { cardUpdateDebounceMs: 0, turnCards: { converge } }
    );
    try {
      projector.scheduleTurnCard({ segmentId: "segment-history", viewVersion: 2, urgency: "immediate", workClass: "history" });
      await vi.runAllTimersAsync();
      expect(converge).toHaveBeenCalledWith("segment-history", "history");
    } finally {
      await projector.stop();
      vi.useRealTimers();
    }
  });

  it("parses colon-containing immutable keys and rejects malformed keys", () => {
    expect(parseTurnCardProjectionKey("turn-card:segment:abc-123:page:4")).toEqual({ segmentId: "segment:abc-123", pageIndex: 4 });
    expect(parseTurnCardProjectionKey("turn-card:segment:abc:page:x")).toBeNull();
  });

  it("handles an async projection notifier rejection through the production store seam", async () => {
    const context = new SqliteContext(":memory:");
    new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    store.setProjectionNotifier(async () => { throw new Error("convergence failed"); });
    const result = store.projectCanonicalEvent({
      laneId: "runtime", laneSequence: 1,
      event: { eventId: "human-runtime", agentKind: "traex", sessionId: "session-runtime", payload: { type: "human_message", text: "hello" } },
      observedAt: new Date().toISOString()
    });
    expect(result.outcome).toBe("created");
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getConversationSegment(result.segmentId!)).toBeTruthy();
    context.close();
  });
});
