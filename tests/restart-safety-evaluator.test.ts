import { describe, expect, it } from "vitest";
import { RestartSafetyEvaluator } from "../src/cli/service-lifecycle/restart-safety-evaluator.js";

const evaluator = new RestartSafetyEvaluator();

describe("RestartSafetyEvaluator", () => {
  it("admits a complete idle status", () => {
    expect(() => evaluator.evaluate(status(), { force: false })).not.toThrow();
  });

  it("allows waiting-behind-scope work when no delivery is actionable", () => {
    expect(() => evaluator.evaluate(status({
      operational: {
        prompts: { running: 0, queued: 0 },
        deliveryRings: { ready: 0, activeClaims: 0, retryWait: 0, waitingBehindScope: 22 },
      },
    }), { force: false })).not.toThrow();
  });

  it("does not treat durable Submission Intent or legacy Prompt evidence as process-local work", () => {
    expect(() => evaluator.evaluate(status({ operational: {
      submissionIntents: { awaitingReceipt: 4, receiptKnown: 3 },
      deliveryRings: { ready: 0, activeClaims: 0, retryWait: 0, waitingBehindScope: 0 }
    } }), { force: false })).not.toThrow();
  });

  it.each([
    ["Worker dispatcher", { instanceWorker: { activeDispatchWorkers: 1, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 } }, /1 dispatchers/],
    ["Worker observer", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 1, activeTurns: 0, uncertainTurns: 0 } }, /1 observers/],
    ["Worker active turn", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 1, uncertainTurns: 0 } }, /1 active turns/],
    ["Worker uncertain turn", { instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 1 } }, /1 uncertain turns/],
    ["ready Ring", ring({ ready: 1 }), /1 Ring-ready/],
    ["claimed Ring work", ring({ activeClaims: 1 }), /1 active claims/],
    ["retry-wait Ring", ring({ retryWait: 1 }), /1 retry-wait/],
    ["active Ring delivery", { deliveryEngine: { activeDeliveries: 1 } }, /1 active Ring deliveries/],
  ])("blocks an unforced restart for %s", (_name, override, expected) => {
    expect(() => evaluator.evaluate(status(override), { force: false })).toThrow(expected);
  });

  it("lets force bypass workload and delivery activity", () => {
    expect(() => evaluator.evaluate(status({
      operational: { deliveryRings: { ready: 1, activeClaims: 1, retryWait: 1, waitingBehindScope: 1 } },
      instanceWorker: { activeDispatchWorkers: 1, activeObservers: 1, activeTurns: 1, uncertainTurns: 1 },
      deliveryEngine: { activeDeliveries: 1 },
    }), { force: true })).not.toThrow();
  });

  it("blocks for durable Ring work and active Ring execution", () => {
    expect(() => evaluator.evaluate(status({
      operational: { deliveryRings: { ready: 2, activeClaims: 0, retryWait: 0, waitingBehindScope: 0 } },
      deliveryEngine: { activeDeliveries: 0 }
    }), { force: false })).toThrow(/2 Ring-ready/);

    expect(() => evaluator.evaluate(status({
      operational: { deliveryRings: { ready: 0, activeClaims: 0, retryWait: 0, waitingBehindScope: 0 } },
      deliveryEngine: { activeDeliveries: 1 }
    }), { force: false })).toThrow(/1 active Ring deliveries/);
  });

  it("lets force bypass a degraded business-integrity audit when SQLite quick check is healthy", () => {
    expect(() => evaluator.evaluate(status({
      sqliteIntegrity: { state: "degraded", quickCheck: "ok" },
    }), { force: true })).not.toThrow();
  });

  it("lets force bypass a terminal degraded startup", () => {
    expect(() => evaluator.evaluate(status({
      startupRecovery: { state: "degraded" },
    }), { force: true })).not.toThrow();
  });

  it("blocks a degraded startup without force", () => {
    expect(() => evaluator.evaluate(status({
      startupRecovery: { state: "degraded" },
    }), { force: false })).toThrow(/retry with --force/);
  });

  it("blocks an unknown startup state even with force", () => {
    expect(() => evaluator.evaluate(status({
      startupRecovery: { state: "future-state" },
    }), { force: true })).toThrow(/inspect startup recovery/);
  });

  it.each([
    ["foreign identity", { identity: { serviceId: "another-service" } }, /identity is another-service/],
    ["missing identity", { identity: {} }, /identity is missing/],
    ["startup recovery", { startupRecovery: { state: "running" } }, /startup recovery is running/],
    ["SQLite quick check", { sqliteIntegrity: { state: "healthy", quickCheck: "failed" } }, /quickCheck failed/],
  ])("does not let force bypass %s", (_name, override, expected) => {
    expect(() => evaluator.evaluate(status(override), { force: true })).toThrow(expected);
  });

  it.each([
    ["workload", { instanceWorker: {} }, false],
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
      operational: { deliveryRings: { ready: 1 } },
      startupRecovery: { state: "running" },
    }), { force: false })).toThrow(/identity is another-service/);
  });
});

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const operationalOverrides = overrides.operational as Record<string, Record<string, unknown>> | undefined;
  return {
    identity: { serviceId: "herdr-agent-swarm" },
    startupRecovery: { state: "completed" },
    instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 },
    deliveryEngine: { activeDeliveries: 0 },
    sqliteIntegrity: { state: "healthy", quickCheck: "ok" },
    ...overrides,
    operational: {
      ...operationalOverrides,
      deliveryRings: { ready: 0, activeClaims: 0, retryWait: 0, waitingBehindScope: 0, ...operationalOverrides?.deliveryRings },
    },
  };
}

function ring(overrides: Record<string, number>): Record<string, unknown> {
  return {
    operational: {
      deliveryRings: { ready: 0, activeClaims: 0, retryWait: 0, waitingBehindScope: 0, ...overrides },
    },
  };
}
