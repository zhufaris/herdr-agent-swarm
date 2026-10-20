import { describe, expect, it, vi } from "vitest";
import { HistoricalRecoveryWorkflow } from "../src/coordinator/historical-recovery-workflow.js";
import type { HistoricalCoreRecoveryCandidate } from "../src/domain/historical-recovery.js";

const candidate = (eventId: string, laneSequence: number): HistoricalCoreRecoveryCandidate => ({
  laneId: "lane-history", eventId, laneSequence,
  sourceId: "source", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session",
  oldestPendingAt: "2026-09-30T00:00:00.000Z",
  route: { ownerKind: "primary", ownerId: "binding", ownerGeneration: 1, gatewayId: "feishu:primary", rootMessageId: "root" }
});

describe("HistoricalRecoveryWorkflow", () => {
  it("yields to live work between individually projected historical events", async () => {
    const pending = [candidate("event-1", 1), candidate("event-2", 2)];
    const order: string[] = [];
    const workflow = new HistoricalRecoveryWorkflow({
      listHistoricalRecoveryCandidates: () => pending.slice(0, 1),
      reprojectHistoricalCandidate: (selected) => {
        order.push(`project:${selected.eventId}`);
        pending.shift();
        return { outcome: "projected", remaining: pending.length > 0 };
      }
    }, {
      maxEvents: 2,
      yieldNow: () => new Promise<void>((resolve) => setImmediate(() => { order.push("live"); resolve(); }))
    });

    await expect(workflow.recoverSlice()).resolves.toMatchObject({
      projected: 2, processed: 2, remaining: false
    });
    expect(order).toEqual(["project:event-1", "live", "project:event-2", "live"]);
  });

  it("reserves bounded never-attempted Turn Cards and wakes delivery only after reservation", async () => {
    const outcomes = ["reserved", "none"] as const;
    const wakeOutbound = vi.fn();
    const recoverNextHistoricalMissingCard = vi.fn(async () => outcomes[recoverNextHistoricalMissingCard.mock.calls.length - 1] ?? "none");
    const workflow = new HistoricalRecoveryWorkflow({
      listHistoricalRecoveryCandidates: () => [],
      reprojectHistoricalCandidate: () => ({ outcome: "stale", remaining: false })
    }, { maxCards: 2, cards: { recoverNextHistoricalMissingCard }, wakeOutbound });

    await expect(workflow.recoverSlice()).resolves.toMatchObject({
      cardsReserved: 1, cardsStale: 0, cardsRemaining: false
    });
    expect(recoverNextHistoricalMissingCard).toHaveBeenCalledTimes(2);
    expect(wakeOutbound).toHaveBeenCalledOnce();
  });

  it("still gives one missing Turn Card a chance after Core consumes the slice time budget", async () => {
    const recoverNextHistoricalMissingCard = vi.fn(async () => "reserved" as const);
    const wakeOutbound = vi.fn();
    let nowCalls = 0;
    const workflow = new HistoricalRecoveryWorkflow({
      listHistoricalRecoveryCandidates: () => [],
      reprojectHistoricalCandidate: () => ({ outcome: "stale", remaining: false })
    }, {
      maxDurationMs: 5_000,
      now: () => nowCalls++ === 0 ? 0 : 6_000,
      cards: { recoverNextHistoricalMissingCard },
      wakeOutbound
    });

    await expect(workflow.recoverSlice()).resolves.toMatchObject({ cardsReserved: 1, cardsRemaining: true });
    expect(recoverNextHistoricalMissingCard).toHaveBeenCalledOnce();
    expect(wakeOutbound).toHaveBeenCalledOnce();
  });
});
