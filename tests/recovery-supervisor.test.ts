import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoverySupervisor } from "../src/coordinator/recovery-supervisor.js";

afterEach(() => vi.useRealTimers());

describe("RecoverySupervisor", () => {
  it.each([
    ["delivering", "requested"],
    ["awaiting_ack", "requested"],
    ["needs_human", "needs_human"]
  ] as const)("catches Core projection up before continuing into the downstream %s stage", async (stage, outcome) => {
    const listPromptIds = vi.fn(() => ["delivery-prompt"]);
    const listWorkerTurnIds = vi.fn(() => ["delivery-turn"]);
    const requestPrompt = vi.fn(async () => undefined);
    const requestWorkerTurn = vi.fn(async () => undefined);
    const supervisor = createSupervisor({
      catchUpProjection: vi.fn(async () => undefined),
      listPromptIds,
      listWorkerTurnIds,
      requestPrompt,
      requestWorkerTurn,
      getBindingStage: vi.fn(() => stage),
      diagnostics: () => ({
        ...emptyEvidence(),
        items: [{ kind: "primary_answer", stage, bindingId: "binding-1", promptId: "delivery-prompt", workerId: null, workerTurnId: null, updatedAt: "2026-10-02T00:00:00.000Z" }]
      })
    });

    await expect(supervisor.recoverBinding("binding-1")).resolves.toEqual(expect.objectContaining({
      outcome,
      selectedStage: "rebuilding_projection",
      stage,
      recoveredTurns: 0,
      promptCount: 1,
      workerTurnCount: 1
    }));
    expect(requestPrompt).toHaveBeenCalledWith("delivery-prompt");
    expect(requestWorkerTurn).toHaveBeenCalledWith("delivery-turn");
    await supervisor.stop();
  });

  it("recovers only binding-owned delivery debt after projection catch-up", async () => {
    const requestPrompt = vi.fn(async () => undefined);
    const requestWorkerTurn = vi.fn(async () => undefined);
    const supervisor = createSupervisor({
      listPromptIds: vi.fn((bindingId) => bindingId === "binding-1" ? ["prompt-1"] : []),
      listWorkerTurnIds: vi.fn((bindingId) => bindingId === "binding-1" ? ["turn-1", "turn-2"] : []),
      requestPrompt,
      requestWorkerTurn
    });

    await expect(supervisor.recoverBinding("binding-1")).resolves.toEqual({
      outcome: "requested",
      selectedStage: "rebuilding_projection",
      stage: "rebuilding_projection",
      recoveredTurns: 0,
      promptCount: 1,
      workerTurnCount: 2
    });
    expect(requestPrompt).toHaveBeenCalledWith("prompt-1");
    expect(requestWorkerTurn).toHaveBeenCalledWith("turn-1");
    expect(requestWorkerTurn).toHaveBeenCalledWith("turn-2");
    await supervisor.stop();
  });

  it("returns a recovered no-op after projection catch-up when the binding has no recovery debt", async () => {
    const catchUpProjection = vi.fn(async () => undefined);
    const awakeExecution = vi.fn(async () => ({ outcome: "recovered" as const, recoveredTurns: 99 }));
    const supervisor = createSupervisor({ catchUpProjection, awakeExecution });

    await expect(supervisor.recoverBinding("binding-1")).resolves.toEqual({
      outcome: "none",
      selectedStage: "recovered",
      stage: "recovered",
      reason: "no_recovery_debt",
      recoveredTurns: 0,
      promptCount: 0,
      workerTurnCount: 0
    });
    expect(catchUpProjection).toHaveBeenCalledExactlyOnceWith("binding-1");
    expect(awakeExecution).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("uses binding-authoritative stage evidence instead of the bounded global diagnostic sample", async () => {
    const getStage = vi.fn((bindingId: string) => bindingId === "target" ? "needs_human" as const : null);
    const supervisor = createSupervisor({
      getBindingStage: getStage,
      diagnostics: () => ({
        ...emptyEvidence(),
        items: Array.from({ length: 20 }, (_, index) => ({
          kind: "primary_answer" as const, stage: "delivering" as const, bindingId: `unrelated-${index}`,
          promptId: `prompt-${index}`, workerId: null, workerTurnId: null, updatedAt: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`
        }))
      })
    });

    await expect(supervisor.recoverBinding("target")).resolves.toMatchObject({
      outcome: "needs_human", stage: "needs_human", reason: "downstream_recovery_needs_human"
    });
    expect(getStage).toHaveBeenCalledWith("target");
    await supervisor.stop();
  });

  it("runs projection delivery discovery in a full pass", async () => {
    const order: string[] = [];
    const supervisor = createSupervisor({
      scanExecution: vi.fn(async () => { order.push("execution"); }),
      scanDelivery: vi.fn(async () => { order.push("delivery"); })
    });

    await supervisor.scan();

    expect(order).toEqual(["delivery"]);
    await supervisor.stop();
  });

  it("repairs delivery alone at the pre-publisher startup barrier", async () => {
    const scanExecution = vi.fn(async () => undefined);
    const scanDelivery = vi.fn(async () => undefined);
    const supervisor = createSupervisor({ scanExecution, scanDelivery });

    await supervisor.repairDeliveryBeforePublisher();

    expect(scanExecution).not.toHaveBeenCalled();
    expect(scanDelivery).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("runs historical recovery only from the periodic lane, never startup repair or eager scan", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const debug = vi.fn();
    const recoverHistory = vi.fn(async () => {
      order.push("history");
      return emptyHistoryResult();
    });
    const supervisor = createSupervisor({
      scanDelivery: vi.fn(async () => { order.push("delivery"); }),
      recoverHistory,
      debug
    });

    await supervisor.repairDeliveryBeforePublisher();
    await supervisor.scan();
    expect(recoverHistory).not.toHaveBeenCalled();

    supervisor.start(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["delivery", "delivery", "delivery", "history"]);
    expect(recoverHistory).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: "historical-recovery-slice-completed", projected: 0,
      backlog: expect.objectContaining({ eligiblePendingEvents: 0, quarantinedEvents: 0 }),
      outcome: "succeeded"
    }), expect.any(String));
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/eventId|messageId|sessionId|cursor|payload|secret/);
    await supervisor.stop();
  });

  it("coalesces duplicate explicit historical recovery wakes", async () => {
    const recoverHistory = vi.fn(async () => emptyHistoryResult());
    const supervisor = createSupervisor({ recoverHistory });

    const first = supervisor.requestHistoricalRecovery();
    const duplicate = supervisor.requestHistoricalRecovery();
    await Promise.all([first, duplicate]);

    expect(recoverHistory).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("runs one successor when an explicit historical slice leaves durable work", async () => {
    const recoverHistory = vi.fn()
      .mockResolvedValueOnce({ ...emptyHistoryResult(), remaining: true })
      .mockResolvedValueOnce(emptyHistoryResult());
    const supervisor = createSupervisor({ recoverHistory });

    await supervisor.requestHistoricalRecovery();

    expect(recoverHistory).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("runs one successor when an explicit historical slice leaves Turn Card work", async () => {
    const recoverHistory = vi.fn()
      .mockResolvedValueOnce({ ...emptyHistoryResult(), cardsRemaining: true })
      .mockResolvedValueOnce(emptyHistoryResult());
    const supervisor = createSupervisor({ recoverHistory });

    await supervisor.requestHistoricalRecovery();

    expect(recoverHistory).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("coalesces in-flight historical wakes into one successor", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const recoverHistory = vi.fn()
      .mockImplementationOnce(async () => { await blocked; return emptyHistoryResult(); })
      .mockResolvedValueOnce(emptyHistoryResult());
    const supervisor = createSupervisor({ recoverHistory });

    const first = supervisor.requestHistoricalRecovery();
    await vi.waitFor(() => expect(recoverHistory).toHaveBeenCalledOnce());
    const followUp = supervisor.requestHistoricalRecovery();
    release();
    await Promise.all([first, followUp]);

    expect(recoverHistory).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("retains targeted delivery hints coalesced with a historical wake", async () => {
    const recoverHistory = vi.fn(async () => emptyHistoryResult());
    const requestPrompt = vi.fn(async () => undefined);
    const requestWorkerTurn = vi.fn(async () => undefined);
    const supervisor = createSupervisor({ recoverHistory, requestPrompt, requestWorkerTurn });

    await Promise.all([
      supervisor.requestHistoricalRecovery(),
      supervisor.requestPrompt("p1"),
      supervisor.requestWorkerTurn("t1")
    ]);

    expect(recoverHistory).toHaveBeenCalledOnce();
    expect(requestPrompt).toHaveBeenCalledExactlyOnceWith("p1");
    expect(requestWorkerTurn).toHaveBeenCalledExactlyOnceWith("t1");
    await supervisor.stop();
  });

  it("coalesces duplicate targeted delivery hints", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const requestPrompt = vi.fn(async () => blocked);
    const requestWorkerTurn = vi.fn(async () => undefined);
    const supervisor = createSupervisor({ requestPrompt, requestWorkerTurn });

    const first = supervisor.requestPrompt("p1");
    const duplicate = supervisor.requestPrompt("p1");
    const worker = supervisor.requestWorkerTurn("t1");
    release();
    await Promise.all([first, duplicate, worker]);

    expect(requestPrompt).toHaveBeenCalledTimes(1);
    expect(requestPrompt).toHaveBeenCalledWith("p1");
    expect(requestWorkerTurn).toHaveBeenCalledTimes(1);
    expect(requestWorkerTurn).toHaveBeenCalledWith("t1");
    await supervisor.stop();
  });

  it("performs one follow-up check for a hint received while the key is active", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const requestPrompt = vi.fn()
      .mockImplementationOnce(async () => blocked)
      .mockResolvedValue(undefined);
    const supervisor = createSupervisor({ requestPrompt });

    const first = supervisor.requestPrompt("p1");
    await vi.waitFor(() => expect(requestPrompt).toHaveBeenCalledTimes(1));
    const followUp = supervisor.requestPrompt("p1");
    const duplicateFollowUp = supervisor.requestPrompt("p1");
    release();
    await Promise.all([first, followUp, duplicateFollowUp]);

    expect(requestPrompt).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("keeps delivery discovery independent of retired execution recovery", async () => {
    const scanDelivery = vi.fn(async () => undefined);
    const supervisor = createSupervisor({
      scanExecution: vi.fn(async () => { throw new Error("execution unavailable"); }),
      scanDelivery
    });

    await supervisor.scan();

    expect(scanDelivery).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("owns the periodic cadence and stops its delivery executor", async () => {
    vi.useFakeTimers();
    const scanDelivery = vi.fn(async () => undefined);
    const stopDelivery = vi.fn(async () => undefined);
    const supervisor = createSupervisor({ scanDelivery, stopDelivery });

    supervisor.start(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(scanDelivery).toHaveBeenCalledOnce();

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(stopDelivery).toHaveBeenCalledOnce();
  });

  it("awaits one active historical slice during shutdown and starts no successor", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const recoverHistory = vi.fn(async () => { await blocked; return { ...emptyHistoryResult(), remaining: true }; });
    const stopDelivery = vi.fn(async () => undefined);
    const supervisor = createSupervisor({ recoverHistory, stopDelivery });
    supervisor.start(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(recoverHistory).toHaveBeenCalledOnce());

    const stopping = supervisor.stop();
    await Promise.resolve();
    expect(stopDelivery).not.toHaveBeenCalled();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(500);

    expect(recoverHistory).toHaveBeenCalledOnce();
    expect(stopDelivery).toHaveBeenCalledOnce();
  });

  it("retains a periodic full scan requested while a targeted pass is active", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const requestPrompt = vi.fn(async () => {
      order.push("target-start");
      await blocked;
      order.push("target-end");
    });
    const scanDelivery = vi.fn(async () => { order.push("delivery"); });
    const supervisor = createSupervisor({ requestPrompt, scanDelivery });

    supervisor.start(100);
    const targeted = supervisor.requestPrompt("p1");
    await vi.waitFor(() => expect(requestPrompt).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(100);

    expect(scanDelivery).not.toHaveBeenCalled();
    release();
    await targeted;

    expect(order).toEqual(["target-start", "target-end", "delivery"]);
    expect(scanDelivery).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("reconstructs every normalized stage from bounded durable evidence", async () => {
    const supervisor = createSupervisor({
      diagnostics: () => ({
        observedAt: "2026-10-02T05:00:00.000Z",
        observingExecution: 1,
        uncertainExecution: 2,
        rebuildingProjection: 3,
        delivering: 4,
        awaitingAck: 5,
        recovered: 6,
        needsHumanDelivery: 7,
        oldestPendingAt: "2026-10-02T04:55:00.000Z",
        oldestPendingAgeSeconds: 300,
        items: [
          { kind: "detached_prompt", stage: "observing_execution", bindingId: "binding-1", promptId: "prompt-1", workerId: null, workerTurnId: null, updatedAt: "2026-10-02T04:55:00.000Z" },
          { kind: "worker_task", stage: "awaiting_ack", bindingId: "binding-1", promptId: null, workerId: "worker-1", workerTurnId: "turn-1", updatedAt: "2026-10-02T04:56:00.000Z" }
        ]
      })
    });

    expect(supervisor.snapshot()).toMatchObject({
      state: "idle",
      lastPassOutcome: null,
      stageCounts: {
        observing_execution: 1,
        rebuilding_projection: 3,
        delivering: 4,
        awaiting_ack: 5,
        recovered: 6,
        needs_human: 9
      },
      oldestPendingAt: "2026-10-02T04:55:00.000Z",
      oldestPendingAgeSeconds: 300,
      lastFailure: null,
      items: [
        { kind: "detached_prompt", stage: "observing_execution", bindingId: "binding-1", promptId: "prompt-1", workerId: null, workerTurnId: null, updatedAt: "2026-10-02T04:55:00.000Z" },
        { kind: "worker_task", stage: "awaiting_ack", bindingId: "binding-1", promptId: null, workerId: "worker-1", workerTurnId: "turn-1", updatedAt: "2026-10-02T04:56:00.000Z" }
      ]
    });
    await supervisor.stop();
  });

  it("records a bounded redacted failed pass and lets a newer success replace it", async () => {
    const scanDelivery = vi.fn()
      .mockRejectedValueOnce(new Error(`Bearer recovery-secret ${"x".repeat(700)}`))
      .mockResolvedValue(undefined);
    const supervisor = createSupervisor({ scanDelivery });

    await supervisor.scan();
    const failed = supervisor.snapshot();
    expect(failed).toMatchObject({ state: "idle", lastPassOutcome: "failed" });
    expect(failed.lastFailure).not.toContain("recovery-secret");
    expect(failed.lastFailure!.length).toBeLessThanOrEqual(500);

    await supervisor.scan();
    expect(supervisor.snapshot()).toMatchObject({
      state: "idle", lastPassOutcome: "succeeded", lastFailure: null,
      version: failed.version + 1
    });
    await supervisor.stop();
  });
});

function createSupervisor(overrides: {
  catchUpProjection?: (bindingId: string) => Promise<void>;
  awakeExecution?: (bindingId: string) => Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string }>;
  scanExecution?: () => Promise<void>;
  listPromptIds?: (bindingId: string, limit: number) => readonly string[];
  listWorkerTurnIds?: (bindingId: string, limit: number) => readonly string[];
  getBindingStage?: (bindingId: string) => import("../src/domain/recovery.js").RecoveryStage | null;
  scanDelivery?: () => Promise<void>;
  requestPrompt?: (promptId: string) => Promise<void>;
  requestWorkerTurn?: (turnId: string) => Promise<void>;
  stopDelivery?: () => Promise<void>;
  recoverHistory?: () => Promise<ReturnType<typeof emptyHistoryResult>>;
  diagnostics?: () => {
    observedAt: string;
    observingExecution: number;
    uncertainExecution: number;
    rebuildingProjection: number;
    delivering: number;
    awaitingAck: number;
    recovered: number;
    needsHumanDelivery: number;
    oldestPendingAt: string | null;
    oldestPendingAgeSeconds: number | null;
    items: Array<{ kind: "detached_prompt" | "uncertain_prompt" | "primary_answer" | "worker_task"; stage: import("../src/domain/recovery.js").RecoveryStage; bindingId: string; promptId: string | null; workerId: string | null; workerTurnId: string | null; updatedAt: string }>;
  };
  warn?: ReturnType<typeof vi.fn>;
  debug?: ReturnType<typeof vi.fn>;
} = {}) {
  return new RecoverySupervisor({
    execution: {
      scan: overrides.scanExecution ?? vi.fn(async () => undefined),
      awake: overrides.awakeExecution ?? vi.fn(async () => ({ outcome: "none" as const, reason: "no_detached_prompt" }))
    },
    conversationProjection: { catchUp: overrides.catchUpProjection ?? vi.fn(async () => undefined) },
    deliveryDebt: {
      listPromptIds: overrides.listPromptIds ?? vi.fn(() => []),
      listWorkerTurnIds: overrides.listWorkerTurnIds ?? vi.fn(() => []),
      getBindingStage: overrides.getBindingStage ?? vi.fn(() => null)
    },
    diagnostics: { snapshot: overrides.diagnostics ?? emptyEvidence },
    delivery: {
      scan: overrides.scanDelivery ?? vi.fn(async () => undefined),
      requestPrompt: overrides.requestPrompt ?? vi.fn(async () => undefined),
      requestWorkerTurn: overrides.requestWorkerTurn ?? vi.fn(async () => undefined),
      stop: overrides.stopDelivery ?? vi.fn(async () => undefined)
    },
    historical: { recoverSlice: overrides.recoverHistory ?? vi.fn(async () => emptyHistoryResult()) },
    logger: { warn: overrides.warn ?? vi.fn(), debug: overrides.debug ?? vi.fn() }
  });
}

function emptyHistoryResult() {
  return {
    projected: 0, retried: 0, quarantined: 0, stale: 0, processed: 0,
    cardsReserved: 0, cardsStale: 0, cardsRemaining: false,
    remaining: false, oldestEligibleAt: null, durationMs: 0,
    backlog: { eligiblePendingEvents: 0, eligibleLanes: 0, ineligiblePendingEvents: 0, quarantinedEvents: 0, oldestEligibleAt: null }
  };
}

function emptyEvidence() {
  return { observedAt: "2026-10-02T00:00:00.000Z", observingExecution: 0, uncertainExecution: 0, rebuildingProjection: 0, delivering: 0, awaitingAck: 0, recovered: 0, needsHumanDelivery: 0, oldestPendingAt: null, oldestPendingAgeSeconds: null, items: [] };
}
