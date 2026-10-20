import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { CommandIntentDispatcher } from "../src/coordinator/command-intent-dispatcher.js";
import type { CommandIntent } from "../src/domain/command-intent.js";

describe("CommandIntentDispatcher", () => {
  it("owns periodic scan failures and retries accepted work on a later interval", async () => {
    vi.useFakeTimers();
    const context = { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
    const accepted: CommandIntent = {
      id: "periodic", idempotencyKey: "periodic", laneKey: "project:project", command: { kind: "new", title: "Periodic" }, context,
      replayPolicy: "safe-before-effect", state: "accepted", attemptCount: 0, outcome: null,
      claimedAt: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z"
    };
    const executable = { ...accepted, state: "executing" as const, attemptCount: 1, claimedAt: "2026-10-16T00:00:00.000Z" };
    let scan = 0;
    let claimed = false;
    const store = {
      getCommandIntent: vi.fn(() => accepted),
      listRecoverableCommandIntents: vi.fn(() => {
        scan += 1;
        if (scan <= 2) throw new Error(`scan failure ${scan}`);
        return [accepted];
      }),
      claimNextCommandIntent: vi.fn(() => claimed ? null : (claimed = true, executable)),
      finishCommandIntent: vi.fn(), recoverExecutingCommandIntents: vi.fn(() => 0), audit: vi.fn(), getBinding: vi.fn()
    };
    const error = vi.fn();
    const selectProject = vi.fn(async () => undefined);
    const dispatcher = new CommandIntentDispatcher({
      store, logger: { error, warn: vi.fn(), info: vi.fn() }, provisioning: { selectProject }, resolver: { resolve: vi.fn() },
      primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() }, outbound: { enqueueCard: vi.fn() }, modelSelection: {}, paneControl: {},
      sessionAdministration: {}, paneClosure: {}, promptRun: {}, instanceControl: {}, wakeCardContext: vi.fn(), presentation: {}
    } as never);

    try {
      dispatcher.start(1_000);
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "swarm-command-startup-scan-failed" }), expect.any(String)
      ));
      error.mockClear();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "swarm-command-periodic-scan-failed", outcome: "deferred" }),
        "Swarm command periodic scan failed; durable scan will retry"
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(selectProject).toHaveBeenCalledOnce());
    } finally {
      await dispatcher.stop();
      vi.useRealTimers();
    }
  });

  it("defers a pre-start wake and catches the durable intent up when dispatch starts", async () => {
    const context = { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
    const intent: CommandIntent = {
      id: "early", idempotencyKey: "early", laneKey: "project:project", command: { kind: "new", title: "Early" }, context,
      replayPolicy: "safe-before-effect", state: "accepted", attemptCount: 0, outcome: null,
      claimedAt: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z"
    };
    const executable = { ...intent, state: "executing" as const, attemptCount: 1, claimedAt: "2026-09-30T00:00:00.000Z" };
    let claimed = false;
    const store = {
      getCommandIntent: vi.fn(() => intent),
      claimNextCommandIntent: vi.fn(() => claimed ? null : (claimed = true, executable)),
      finishCommandIntent: vi.fn(), recoverExecutingCommandIntents: vi.fn(() => 0), listRecoverableCommandIntents: vi.fn(() => [intent]), audit: vi.fn(), getBinding: vi.fn()
    };
    const selectProject = vi.fn(async () => {});
    const dispatcher = new CommandIntentDispatcher({
      store, logger: pino({ enabled: false }), provisioning: { selectProject }, resolver: { resolve: vi.fn() },
      primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() }, outbound: { enqueueCard: vi.fn() }, modelSelection: {}, paneControl: {},
      sessionAdministration: {}, paneClosure: {}, promptRun: {}, instanceControl: {}, wakeCardContext: vi.fn(), deferDispatchUntilRecovery: true, presentation: {}
    } as never);

    dispatcher.wake(intent.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(selectProject).not.toHaveBeenCalled();
    expect(store.claimNextCommandIntent).not.toHaveBeenCalled();

    dispatcher.start(60_000);
    await vi.waitFor(() => expect(selectProject).toHaveBeenCalledOnce());
    await dispatcher.stop();
  });

  it("claims and executes accepted work from one lane in durable FIFO order", async () => {
    const context = { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
    const intents: CommandIntent[] = ["first", "second"].map((id) => ({
      id, idempotencyKey: id, laneKey: "project:project", command: { kind: "new", title: id }, context,
      replayPolicy: "safe-before-effect", state: "executing", attemptCount: 1, outcome: null,
      claimedAt: "2026-09-24T00:00:00.000Z", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z"
    }));
    const claims = [...intents];
    const order: string[] = [];
    const store = {
      claimNextCommandIntent: vi.fn(() => claims.shift() ?? null),
      finishCommandIntent: vi.fn((id: string) => { order.push(`finish:${id}`); }),
      getBinding: vi.fn(), recoverExecutingCommandIntents: vi.fn(), listRecoverableCommandIntents: vi.fn(), audit: vi.fn()
    };
    const selectProject = vi.fn(async (_message, title: string) => { order.push(`effect:${title}`); });
    const dispatcher = new CommandIntentDispatcher({
      store, logger: pino({ enabled: false }), provisioning: { selectProject },
      resolver: { resolve: vi.fn() }, primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() },
      outbound: { enqueueCard: vi.fn() }, modelSelection: {}, paneControl: {}, sessionAdministration: {}, paneClosure: {}, promptRun: {}, instanceControl: {},
      wakeCardContext: vi.fn(), presentation: {}
    } as never);

    await dispatcher.drain(intents[0]!);

    expect(order).toEqual(["effect:first", "finish:first", "effect:second", "finish:second"]);
    expect(store.claimNextCommandIntent).toHaveBeenCalledTimes(3);
  });

  it("dispatches a confirmed clear to the durable Orchestrator workflow", async () => {
    const context = { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "confirmation-source", actorOpenId: "admin", projectId: "project", workspaceId: "w1", primary: { bindingId: "binding", bindingGeneration: 2, paneId: "w1:p1", terminalId: "terminal-1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, activePromptId: null } };
    const intent: CommandIntent = {
      id: "intent-clear", idempotencyKey: "natural-language-confirmation:confirm-1:clear", laneKey: "binding:binding", command: { kind: "clear" }, context,
      replayPolicy: "non-replayable", state: "executing", attemptCount: 1, outcome: null, claimedAt: "2026-10-02T00:00:00.000Z", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z"
    };
    let claimed = false;
    const store = {
      claimNextCommandIntent: vi.fn(() => claimed ? null : (claimed = true, intent)), finishCommandIntent: vi.fn(),
      getBinding: vi.fn(() => ({ id: "binding", kind: "orchestrator", generation: 2, paneId: "w1:p1", traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" })),
      recoverExecutingCommandIntents: vi.fn(), listRecoverableCommandIntents: vi.fn(), audit: vi.fn()
    };
    const request = vi.fn(async () => ({ id: "orchestrator-clear:intent-clear", state: "succeeded", detail: null }));
    const dispatcher = new CommandIntentDispatcher({
      store, logger: pino({ enabled: false }), orchestratorClear: { request }, resolver: { resolve: vi.fn() }, primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() },
      provisioning: {}, outbound: { enqueueCard: vi.fn() }, modelSelection: {}, paneControl: {}, sessionAdministration: {}, paneClosure: {}, promptRun: {}, instanceControl: {}, wakeCardContext: vi.fn(), presentation: { commandStatus: vi.fn() }
    } as never);

    await dispatcher.drain(intent);

    expect(request).toHaveBeenCalledWith({ id: "orchestrator-clear:intent-clear", idempotencyKey: "orchestrator-clear:intent-clear", bindingId: "binding", actorOpenId: "admin", sourceMessageId: "confirmation-source", confirmationId: "confirm-1" });
    expect(store.finishCommandIntent).toHaveBeenCalledWith("intent-clear", "succeeded", expect.objectContaining({ code: "succeeded", operationKind: "orchestrator-clear", operationId: "orchestrator-clear:intent-clear" }), expect.any(Function));
  });

  it("redelivers cards after projection catch-up reports recovered evidence", async () => {
    const fixture = awakeFixture({ outcome: "recovered", recoveredTurns: 2 });
    await fixture.dispatcher.drain(fixture.intent);
    expect(fixture.recoverySupervisor.recoverBinding).toHaveBeenCalledWith("b1");
    expect(fixture.primaryCardRedelivery.redeliver).toHaveBeenCalledWith({ commandIntentId: "awake-intent", bindingId: "b1", expectedBindingGeneration: 3 });
    expect(fixture.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "succeeded", expect.objectContaining({ code: "redelivery_scheduled" }), expect.any(Function));
  });

  it.each([
    ["no_detached_prompt", false, "redelivery_scheduled"],
    ["no_complete_later_turn", true, "redelivery_scheduled"]
  ] as const)("schedules durable card redelivery for %s without replaying a Prompt", async (reason, remainsDetached, code) => {
    const fixture = awakeFixture({ outcome: "none", reason });
    await fixture.dispatcher.drain(fixture.intent);
    expect(fixture.primaryCardRedelivery.redeliver).toHaveBeenCalledWith({
      commandIntentId: "awake-intent", bindingId: "b1", expectedBindingGeneration: 3
    });
    expect(fixture.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "succeeded", expect.objectContaining({ code }), expect.any(Function));
    const rendered = fixture.presentation.awakeStatus.mock.calls[0]![0];
    expect(rendered.redelivery).toEqual({ outcome: "scheduled", answerScheduled: true });
    if (remainsDetached) expect(rendered.executionReason).toBe("no_complete_later_turn");
  });

  it("fails closed without redelivery while projection catch-up is busy", async () => {
    const fixture = awakeFixture({ outcome: "busy", reason: "observer_transition" });
    await fixture.dispatcher.drain(fixture.intent);
    expect(fixture.primaryCardRedelivery.redeliver).not.toHaveBeenCalled();
    expect(fixture.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "rejected", expect.objectContaining({ code: "recovery_unavailable" }), expect.any(Function));
  });

  it.each([
    { outcome: "unavailable" as const, reason: "projection_needs_human" },
    { outcome: "none" as const, reason: "projection_current" }
  ])("redelivers cards after a non-busy projection result %#", async (recovery) => {
    const fixture = awakeFixture(recovery);
    await fixture.dispatcher.drain(fixture.intent);
    expect(fixture.primaryCardRedelivery.redeliver).toHaveBeenCalledOnce();
    expect(fixture.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "succeeded", expect.objectContaining({ code: "redelivery_scheduled" }), expect.any(Function));
  });

  it("reports a persisted same-Intent reservation as already scheduled", async () => {
    const fixture = awakeFixture(
      { outcome: "none", reason: "no_detached_prompt" },
      { outcome: "duplicate", mainScheduled: true, answerScheduled: false }
    );
    await fixture.dispatcher.drain(fixture.intent);
    expect(fixture.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "succeeded", expect.objectContaining({ code: "redelivery_already_scheduled" }), expect.any(Function));
    expect(fixture.presentation.awakeStatus.mock.calls[0]![0].redelivery).toEqual({ outcome: "duplicate", answerScheduled: false });
  });

  it("distinguishes Main-only scheduling and rejects a fenced redelivery", async () => {
    const mainOnly = awakeFixture(
      { outcome: "none", reason: "no_detached_prompt" },
      { outcome: "scheduled", mainScheduled: true as const, answerScheduled: false }
    );
    await mainOnly.dispatcher.drain(mainOnly.intent);
    expect(mainOnly.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "succeeded", expect.objectContaining({ code: "main_redelivery_scheduled" }), expect.any(Function));
    expect(mainOnly.presentation.awakeStatus.mock.calls[0]![0].redelivery).toEqual({ outcome: "scheduled", answerScheduled: false });

    const fenced = awakeFixture(
      { outcome: "none", reason: "no_detached_prompt" },
      { outcome: "stale", reason: "projection_changed" }
    );
    await fenced.dispatcher.drain(fenced.intent);
    expect(fenced.store.finishCommandIntent).toHaveBeenCalledWith("awake-intent", "rejected", expect.objectContaining({ code: "redelivery_unavailable" }), expect.any(Function));
    expect(fenced.presentation.awakeStatus.mock.calls[0]![0].redelivery).toEqual({ outcome: "unavailable", reason: "projection_changed" });
  });
});

function awakeFixture(
  recovery: { outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string },
  redelivery: { outcome: "scheduled" | "duplicate"; mainScheduled: true; answerScheduled: boolean } | { outcome: "stale" | "unavailable"; reason: string }
    = { outcome: "scheduled", mainScheduled: true, answerScheduled: true }
) {
  const context = {
    chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "awake-message", actorOpenId: "creator",
    projectId: "project", workspaceId: "workspace",
    primary: { bindingId: "b1", bindingGeneration: 3, paneId: "w1:p1", terminalId: "terminal-1", nativeSession: null, activePromptId: null }
  };
  const intent: CommandIntent = {
    id: "awake-intent", idempotencyKey: "awake-intent", laneKey: "binding:b1", command: { kind: "awake" }, context,
    replayPolicy: "reconcilable", state: "executing", attemptCount: 1, outcome: null,
    claimedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  };
  let claimed = false;
  const store = {
    claimNextCommandIntent: vi.fn(() => claimed ? null : (claimed = true, intent)), finishCommandIntent: vi.fn(),
    getBinding: vi.fn(() => ({ id: "b1", generation: 3, paneId: "w1:p1", traexSessionId: "terminal-1", agentSessionSource: null })),
    recoverExecutingCommandIntents: vi.fn(), listRecoverableCommandIntents: vi.fn(), audit: vi.fn()
  };
  const recoveryResult = recovery.outcome === "recovered"
    ? { outcome: "recovered" as const, selectedStage: "observing_execution" as const, stage: "recovered" as const, recoveredTurns: recovery.recoveredTurns, promptCount: 0, workerTurnCount: 0 }
    : recovery.outcome === "busy"
      ? { outcome: "busy" as const, selectedStage: "observing_execution" as const, stage: "observing_execution" as const, reason: recovery.reason, recoveredTurns: 0, promptCount: 0, workerTurnCount: 0 }
      : recovery.outcome === "unavailable"
        ? { outcome: "needs_human" as const, selectedStage: "observing_execution" as const, stage: "needs_human" as const, reason: recovery.reason, recoveredTurns: 0, promptCount: 0, workerTurnCount: 0 }
        : { outcome: "none" as const, selectedStage: "recovered" as const, stage: "recovered" as const, reason: "no_recovery_debt", executionReason: recovery.reason, recoveredTurns: 0, promptCount: 0, workerTurnCount: 0 };
  const recoverySupervisor = { recoverBinding: vi.fn(async () => recoveryResult) };
  const primaryCardRedelivery = { redeliver: vi.fn(() => redelivery) };
  const presentation = { awakeStatus: vi.fn((result) => ({ result })), commandStatus: vi.fn(() => ({})) };
  const dispatcher = new CommandIntentDispatcher({
    store, logger: pino({ enabled: false }), provisioning: {}, resolver: { resolve: vi.fn() },
    primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() }, outbound: { enqueueCard: vi.fn(async () => undefined) },
    modelSelection: {}, paneControl: {}, sessionAdministration: {}, paneClosure: {}, recoverySupervisor, primaryCardRedelivery,
    instanceControl: {}, wakeCardContext: vi.fn(), presentation
  } as never);
  return { dispatcher, intent, store, recoverySupervisor, primaryCardRedelivery, presentation };
}
