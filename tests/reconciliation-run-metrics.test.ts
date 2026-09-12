import { describe, expect, it } from "vitest";
import { ReconciliationRunMetrics } from "../src/runtime/reconciliation-run-metrics.js";

describe("ReconciliationRunMetrics", () => {
  it("records successful, failed, and coalesced passes", async () => {
    const metrics = new ReconciliationRunMetrics();
    metrics.markCoalesced();
    await metrics.measure(async () => undefined);
    await expect(metrics.measure(async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");

    expect(metrics.snapshot("idle")).toMatchObject({
      state: "idle", runCount: 2, successCount: 1, failureCount: 1, coalescedRequestCount: 1,
      lastStartedAt: expect.any(String), lastCompletedAt: expect.any(String), lastDurationMs: expect.any(Number), maxDurationMs: expect.any(Number), lastOutcome: "failed"
    });
  });

  it("records a contained partial failure without rejecting the operation", async () => {
    const metrics = new ReconciliationRunMetrics();

    await expect(metrics.measure(async () => ({ failures: [{ workspaceId: "w1", message: "x".repeat(600) }] }))).resolves.toBeDefined();

    expect(metrics.snapshot("idle")).toMatchObject({
      runCount: 1, successCount: 0, failureCount: 1, lastOutcome: "failed",
      lastFailures: [{ workspaceId: "w1", message: "x".repeat(500) }]
    });
  });
});
