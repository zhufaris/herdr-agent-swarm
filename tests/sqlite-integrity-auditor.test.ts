import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteIntegrityAuditor } from "../src/runtime/sqlite-integrity-auditor.js";
import { WorkerDatabaseIntegrityStore } from "../src/runtime/sqlite-integrity-worker.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

afterEach(() => vi.useRealTimers());

describe("SQLite integrity auditor", () => {
  it("runs a real database inspection without blocking the main event loop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-integrity-worker-"));
    const databasePath = join(directory, "bridge.db");
    const store = new SqliteBindingStore(databasePath);
    store.close();
    try {
      const inspection = new WorkerDatabaseIntegrityStore(databasePath).inspectIntegrity(20);
      let timerObserved = false;
      await new Promise<void>((resolve) => setTimeout(() => { timerObserved = true; resolve(); }, 0));

      expect(timerObserved).toBe(true);
      await expect(inspection).resolves.toEqual({ quickCheck: "ok", issues: [], truncated: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs immediately and caches a healthy bounded snapshot", async () => {
    const auditor = new SqliteIntegrityAuditor(
      { inspectIntegrity: () => ({ quickCheck: "ok", issues: [], truncated: false }) },
      { intervalMs: 900_000, issueLimit: 20 },
      { info() {}, error() {} },
      () => 1_000
    );

    expect(auditor.snapshot()).toMatchObject({ state: "idle", startedAt: null, completedAt: null });
    await auditor.run();
    expect(auditor.snapshot()).toEqual({ state: "healthy", quickCheck: "ok", issues: [], truncated: false, startedAt: new Date(1_000).toISOString(), completedAt: new Date(1_000).toISOString(), durationMs: 0, error: null });
  });

  it("coalesces overlapping runs and retains bounded degraded findings", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const auditor = new SqliteIntegrityAuditor(
      { async inspectIntegrity() { calls += 1; await gate; return { quickCheck: "ok" as const, issues: [{ rule: "broken_rule", table: "safe_table", count: 2 }], truncated: false }; } },
      { intervalMs: 900_000, issueLimit: 20 },
      { info() {}, error() {} }
    );

    const first = auditor.run();
    const second = auditor.run();
    expect(auditor.snapshot().state).toBe("running");
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(auditor.snapshot()).toMatchObject({ state: "degraded", quickCheck: "ok", issues: [{ rule: "broken_rule", table: "safe_table", count: 2 }], error: null });
  });

  it("captures and bounds inspection errors without rejecting", async () => {
    const auditor = new SqliteIntegrityAuditor(
      { inspectIntegrity() { throw new Error(`secret-${"x".repeat(400)}`); } },
      { intervalMs: 900_000, issueLimit: 20 },
      { info() {}, error() {} }
    );

    await expect(auditor.run()).resolves.toBeUndefined();
    expect(auditor.snapshot()).toMatchObject({ state: "degraded", quickCheck: "failed", issues: [], truncated: false });
    expect(auditor.snapshot().error?.length).toBeLessThanOrEqual(240);
  });

  it("starts immediately and stops future interval runs", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const auditor = new SqliteIntegrityAuditor(
      { inspectIntegrity: () => { calls += 1; return { quickCheck: "ok", issues: [], truncated: false }; } },
      { intervalMs: 60_000, issueLimit: 20 },
      { info() {}, error() {} }
    );

    auditor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    await auditor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(2);
  });

  it("waits for an in-flight inspection before stopping", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const auditor = new SqliteIntegrityAuditor(
      { async inspectIntegrity() { await gate; return { quickCheck: "ok" as const, issues: [], truncated: false }; } },
      { intervalMs: 60_000, issueLimit: 20 },
      { info() {}, error() {} }
    );
    auditor.start();
    let stopped = false;
    const stopping = auditor.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
