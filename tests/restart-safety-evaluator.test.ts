import { describe, expect, it } from "vitest";
import { RestartSafetyEvaluator } from "../src/cli/service-lifecycle/restart-safety-evaluator.js";

const evaluator = new RestartSafetyEvaluator();

describe("RestartSafetyEvaluator", () => {
  it("admits a complete idle status", () => {
    expect(() => evaluator.evaluate(status(), { force: false })).not.toThrow();
  });

  it("allows waiting-behind-lane work when no delivery is actionable", () => {
    expect(() => evaluator.evaluate(status({
      operational: {
        prompts: { running: 0, queued: 0 },
        outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 22 },
      },
    }), { force: false })).not.toThrow();
  });

  it.each([
    ["running prompt", { operational: { prompts: { running: 1, queued: 0 } } }, /1 running prompts/],
    ["queued prompt", { operational: { prompts: { running: 0, queued: 1 } } }, /1 queued prompts/],
    ["Primary worker", { promptWorker: { activeTurnWorkers: 1 } }, /1 active turn workers/],
    ["Worker dispatcher", { instanceWorker: { activeDispatchWorkers: 1, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 } }, /1 dispatchers/],
    ["Worker observer", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 1, activeTurns: 0, uncertainTurns: 0 } }, /1 observers/],
    ["Worker active turn", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 1, uncertainTurns: 0 } }, /1 active turns/],
    ["Worker uncertain turn", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 1 } }, /1 uncertain turns/],
    ["ready outbox", outbox({ ready: 1 }), /1 ready/],
    ["in-flight outbox", outbox({ inFlight: 1 }), /1 in-flight/],
    ["retry-wait outbox", outbox({ retryWait: 1 }), /1 retry-wait/],
    ["cooldown outbox", outbox({ cooldownWait: 1 }), /1 cooldown-wait/],
    ["active delivery", { outboxDispatcher: { activeDeliveries: 1 } }, /1 active deliveries/],
  ])("blocks an unforced restart for %s", (_name, override, expected) => {
    expect(() => evaluator.evaluate(status(override), { force: false })).toThrow(expected);
  });

  it("lets force bypass workload and delivery activity", () => {
    expect(() => evaluator.evaluate(status({
      operational: {
        prompts: { running: 1, queued: 2 },
        outboxWork: { ready: 1, inFlight: 1, retryWait: 1, cooldownWait: 1, waitingBehindLane: 1 },
      },
      promptWorker: { activeTurnWorkers: 1 },
      instanceWorker: { activeDispatchWorkers: 1, activeObservers: 1, activeTurns: 1, uncertainTurns: 1 },
      outboxDispatcher: { activeDeliveries: 1 },
    }), { force: true })).not.toThrow();
  });

  it.each([
    ["foreign identity", { identity: { serviceId: "another-service" } }, /identity is another-service/],
    ["missing identity", { identity: {} }, /identity is missing/],
    ["startup recovery", { startupRecovery: { state: "running" } }, /startup recovery is running/],
    ["SQLite state", { sqliteIntegrity: { state: "degraded", quickCheck: "ok" } }, /SQLite integrity is degraded/],
    ["SQLite quick check", { sqliteIntegrity: { state: "healthy", quickCheck: "failed" } }, /quickCheck failed/],
  ])("does not let force bypass %s", (_name, override, expected) => {
    expect(() => evaluator.evaluate(status(override), { force: true })).toThrow(expected);
  });

  it.each([
    ["workload", { promptWorker: {} }, false],
    ["startup recovery", { startupRecovery: {} }, false],
    ["SQLite integrity", { sqliteIntegrity: {} }, false],
    ["startup recovery under force", { startupRecovery: {} }, true],
    ["SQLite integrity under force", { sqliteIntegrity: {} }, true],
  ])("fails closed for incomplete %s", (_name, override, force) => {
    expect(() => evaluator.evaluate(status(override), { force })).toThrow(/incomplete restart safety metrics/);
  });

  it("preserves failure precedence", () => {
    expect(() => evaluator.evaluate(status({
      identity: { serviceId: "another-service" },
      operational: { prompts: { running: 1, queued: 0 } },
      startupRecovery: { state: "running" },
    }), { force: false })).toThrow(/identity is another-service/);
  });
});

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: { serviceId: "herdr-agent-swarm" },
    startupRecovery: { state: "completed" },
    operational: {
      prompts: { running: 0, queued: 0 },
      outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0 },
    },
    promptWorker: { activeTurnWorkers: 0 },
    instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 },
    outboxDispatcher: { activeDeliveries: 0 },
    sqliteIntegrity: { state: "healthy", quickCheck: "ok" },
    ...overrides,
  };
}

function outbox(overrides: Record<string, number>): Record<string, unknown> {
  return {
    operational: {
      prompts: { running: 0, queued: 0 },
      outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0, ...overrides },
    },
  };
}
