import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { StartupRecoveryWorkflow } from "../src/coordinator/startup-recovery-workflow.js";

function harness(overrides: { legacyRecover?: () => Promise<void>; recoverInitial?: boolean; fullRescanRequired?: boolean } = {}) {
  const order: string[] = [];
  const initialSelection = { id: "selection-1", bindingId: "binding-1", initialPromptText: "recover initial input" };
  const initialBinding = { id: "binding-1" };
  const initialAgentInput = { submit: vi.fn(async () => ({ outcome: "duplicate" as const, submissionId: "submission-1" })) };
  const sessionOperations = {
    recover: vi.fn(overrides.legacyRecover ?? (async () => { order.push("legacy:recover"); })),
    stop: vi.fn(async () => {}), snapshot: vi.fn(() => ({ state: "idle", activeOperations: 0, drainRequested: false, lastCompletedAt: null, lastFailureAt: null, lastFailure: null }))
  };
  const swarmCommands = { recover: vi.fn(async () => { order.push("commands:recover"); }), start: vi.fn(() => { order.push("commands:start"); }) };
  const gatewayIngress = { start: vi.fn(async () => { order.push("gateway:start"); }), stop: vi.fn(async () => {}) };
  const inboundPipeline = { recover: vi.fn(() => 0), start: vi.fn(() => { order.push("inbound:start"); }), stop: vi.fn(async () => {}), snapshot: vi.fn(), receive: vi.fn() };
  const legacyInputCards = { scan: vi.fn(() => 1) };
  const wakeOutbound = vi.fn();
  const startupViews = {
    converge: vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: overrides.fullRescanRequired ?? false })),
    continueRetainedActivity: vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: false })),
    convergeBindings: vi.fn(async () => [])
  };
  const workflow = new StartupRecoveryWorkflow({
    config: { reconcileIntervalMs: 30_000, projects: [], lark: { chatId: "chat" } },
    store: { recoverLegacyElementIdDeadLetters: vi.fn(() => 0), listCompletedProjectSelectionsWithInitialPrompt: vi.fn(() => overrides.recoverInitial ? [initialSelection] : []), getBinding: vi.fn(() => overrides.recoverInitial ? initialBinding : null) },
    herdr: { assertWorkspace: vi.fn(async () => {}) }, gatewayIngress, gatewaySink: {}, logger: pino({ enabled: false }),
    scheduler: { subscribe: vi.fn(() => () => {}), wake: vi.fn() },
    promptRun: { prepareRecovery: vi.fn(), start: vi.fn(() => { order.push("prompts:start"); }) },
    provisioning: { recover: vi.fn(async () => {}) }, paneControl: { recover: vi.fn(async () => {}), drainPaneControls: vi.fn(async () => {}) },
    paneClosure: { recover: vi.fn(async () => {}) }, reconciler: { captureBaselines: vi.fn(async () => {}), reconcile: vi.fn(async () => {}), start: vi.fn() },
    retiredPaneCleanup: { recover: vi.fn(async () => {}), start: vi.fn() }, startupViews,
    sessionOperations, swarmCommands, inboundPipeline, cardActionRouter: {}, initialAgentInput, promptAdmission: { acceptInitial: vi.fn(async () => {}) },
    legacyInputCards, wakeOutbound
  } as never);
  return { workflow, order, sessionOperations, swarmCommands, gatewayIngress, inboundPipeline, initialAgentInput, initialSelection, initialBinding, legacyInputCards, wakeOutbound, startupViews };
}

describe("StartupRecoveryWorkflow legacy control barrier", () => {
  it("reserves legacy Input Card deletions during delivery preparation", async () => {
    const h = harness();

    await h.workflow.prepareDelivery();

    expect(h.legacyInputCards.scan).toHaveBeenCalledWith(100);
    expect(h.wakeOutbound).toHaveBeenCalledOnce();
    await h.workflow.stop();
  });

  it("completes initial view convergence while scheduling bounded retained continuation", async () => {
    vi.useFakeTimers();
    const h = harness({ fullRescanRequired: true });

    await h.workflow.prepareDelivery();
    expect(h.workflow.snapshot()).toMatchObject({
      stages: expect.arrayContaining([expect.objectContaining({ name: "view-convergence", state: "completed" })]),
      startupViews: { fullRescanPending: false, continuationPending: true, lastFailure: null }
    });
    await h.workflow.recoverRuntime();
    expect(h.workflow.snapshot().startupViews).toMatchObject({ state: "retry_wait", fullRescanPending: false, continuationPending: true, lastFailure: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.startupViews.converge).toHaveBeenCalledOnce();
    expect(h.startupViews.continueRetainedActivity).toHaveBeenCalledOnce();
    expect(h.workflow.snapshot().startupViews).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false, lastFailure: null });
    await h.workflow.stop();
    vi.useRealTimers();
  });

  it("recovers completed project bootstrap through idempotent Agent Input", async () => {
    const h = harness({ recoverInitial: true });

    await h.workflow.start();

    expect(h.initialAgentInput.submit).toHaveBeenCalledWith(h.initialBinding, h.initialSelection);
    await h.workflow.stop();
  });

  it("completes legacy recovery before CommandIntent recovery and opens ingress only afterward", async () => {
    const h = harness();

    await h.workflow.recoverRuntime();
    await h.workflow.start();

    expect(h.order).toEqual(["legacy:recover", "commands:recover", "commands:start", "gateway:start", "inbound:start"]);
    expect("start" in h.sessionOperations).toBe(false);
    await h.workflow.stop();
  });

  it("does not recover or dispatch CommandIntent work when legacy convergence fails", async () => {
    const h = harness({ legacyRecover: async () => { throw new Error("legacy drain failed"); } });

    await expect(h.workflow.start()).rejects.toThrow("legacy drain failed");

    expect(h.swarmCommands.recover).not.toHaveBeenCalled();
    expect(h.swarmCommands.start).not.toHaveBeenCalled();
    expect(h.gatewayIngress.start).not.toHaveBeenCalled();
    expect(h.inboundPipeline.start).not.toHaveBeenCalled();
    await h.workflow.stop();
  });
});
