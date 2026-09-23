import { describe, expect, it, vi } from "vitest";
import type { HerdrPort } from "../src/domain/ports.js";
import { HerdrCircuitBreaker, HerdrCircuitOpenError, isHerdrTransportFailure } from "../src/runtime/herdr-circuit-breaker.js";
import { CommandError } from "../src/infra/command-runner.js";

describe("HerdrCircuitBreaker", () => {
  it("opens after consecutive transport failures and fails fast during cooldown", async () => {
    let now = 1_000;
    const assertWorkspace = vi.fn(async () => { throw new Error("connect ECONNREFUSED /run/herdr.sock"); });
    const breaker = new HerdrCircuitBreaker(adapter({ assertWorkspace }), { failureThreshold: 2, openMs: 500 }, undefined, () => now);

    await expect(breaker.assertWorkspace("w1")).rejects.toThrow("ECONNREFUSED");
    await expect(breaker.assertWorkspace("w1")).rejects.toThrow("ECONNREFUSED");
    await expect(breaker.assertWorkspace("w1")).rejects.toBeInstanceOf(HerdrCircuitOpenError);

    expect(assertWorkspace).toHaveBeenCalledTimes(2);
    expect(breaker.status()).toMatchObject({ state: "open", consecutiveFailures: 2, rejectedCalls: 1, openedAt: new Date(1_000).toISOString(), nextProbeAt: new Date(1_500).toISOString() });
  });

  it("allows one safe half-open probe and closes after recovery", async () => {
    let now = 1_000;
    let recover = false;
    let release!: () => void;
    const probeWait = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => {
      if (!recover) throw new Error("Command failed: herdr api snapshot: socket closed");
      await probeWait;
      return [];
    });
    const breaker = new HerdrCircuitBreaker(adapter({ listPanes }), { failureThreshold: 1, openMs: 500 }, undefined, () => now);
    await expect(breaker.listPanes("w1")).rejects.toThrow("socket closed");
    now = 1_500; recover = true;

    const probe = breaker.listPanes("w1");
    await vi.waitFor(() => expect(breaker.status().state).toBe("half_open"));
    await expect(breaker.getPane("w1:p1")).rejects.toBeInstanceOf(HerdrCircuitOpenError);
    release();
    await expect(probe).resolves.toEqual([]);

    expect(breaker.status()).toMatchObject({ state: "closed", consecutiveFailures: 0, successfulProbes: 1, rejectedCalls: 1 });
  });

  it("never uses prompt dispatch as a half-open probe or retries it", async () => {
    let now = 1_000;
    const runPrompt = vi.fn(async () => "done" as const);
    const breaker = new HerdrCircuitBreaker(adapter({
      async assertWorkspace() { throw new Error("connect ECONNREFUSED"); }, runPrompt
    }), { failureThreshold: 1, openMs: 500 }, undefined, () => now);
    await expect(breaker.assertWorkspace("w1")).rejects.toThrow();
    now = 1_500;

    await expect(breaker.runPrompt("w1:p1", "hello", 1_000)).rejects.toBeInstanceOf(HerdrCircuitOpenError);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it("records but never retries a transport failure from prompt dispatch", async () => {
    const runPrompt = vi.fn(async () => { throw new Error("connection lost after prompt submission"); });
    const breaker = new HerdrCircuitBreaker(adapter({ runPrompt }), { failureThreshold: 1, openMs: 500 });

    await expect(breaker.runPrompt("w1:p1", "hello", 1_000)).rejects.toThrow("connection lost");
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(breaker.status()).toMatchObject({ state: "open", totalTransportFailures: 1 });
  });

  it("redacts credentials from the retained transport failure", async () => {
    const breaker = new HerdrCircuitBreaker(adapter({
      async assertWorkspace() { throw new Error("connect ECONNREFUSED Bearer circuit-secret"); }
    }), { failureThreshold: 1, openMs: 500 });

    await expect(breaker.assertWorkspace("w1")).rejects.toThrow("ECONNREFUSED");

    expect(breaker.status().lastFailure).toBe("connect ECONNREFUSED Bearer [REDACTED]");
    expect(JSON.stringify(breaker.status())).not.toContain("circuit-secret");
  });

  it("does not count domain errors as transport failures", async () => {
    const getPane = vi.fn(async () => { throw new Error("pane w1:p1 not found"); });
    const breaker = new HerdrCircuitBreaker(adapter({ getPane }), { failureThreshold: 1, openMs: 500 });

    await expect(breaker.getPane("w1:p1")).rejects.toThrow("not found");
    await expect(breaker.getPane("w1:p1")).rejects.toThrow("not found");
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(breaker.status()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("closes after a half-open probe reaches Herdr even when the operation has a domain error", async () => {
    let now = 1_000;
    let domainError = false;
    const getPane = vi.fn(async () => {
      if (!domainError) throw new Error("connect ECONNREFUSED");
      throw new Error("pane w1:p1 not found");
    });
    const breaker = new HerdrCircuitBreaker(adapter({ getPane }), { failureThreshold: 1, openMs: 500 }, undefined, () => now);
    await expect(breaker.getPane("w1:p1")).rejects.toThrow("ECONNREFUSED");
    now = 1_500; domainError = true;

    await expect(breaker.getPane("w1:p1")).rejects.toThrow("not found");
    expect(breaker.status()).toMatchObject({ state: "closed", consecutiveFailures: 0, successfulProbes: 1 });
  });

  it("keeps passive runtime waits outside circuit admission", async () => {
    let now = 1_000;
    const waitForRuntimeChange = vi.fn(async () => undefined);
    const breaker = new HerdrCircuitBreaker(adapter({
      async assertWorkspace() { throw new Error("connect ECONNREFUSED"); }, waitForRuntimeChange
    }), { failureThreshold: 1, openMs: 500 }, undefined, () => now);
    await expect(breaker.assertWorkspace("w1")).rejects.toThrow();

    await expect(breaker.waitForRuntimeChange("w1:p1", 100)).resolves.toBeUndefined();
    expect(waitForRuntimeChange).toHaveBeenCalledOnce();
    expect(breaker.status().rejectedCalls).toBe(0);
  });

  it("recognizes wrapped CLI absence and native socket timeouts as transport failures", () => {
    expect(isHerdrTransportFailure(new CommandError("herdr", ["api", "snapshot"], "spawn herdr ENOENT", false))).toBe(true);
    expect(isHerdrTransportFailure(new Error("socket_request_timeout"))).toBe(true);
    expect(isHerdrTransportFailure(new Error("Herdr pane w1:p1 remained present after close"))).toBe(false);
  });
});

function adapter(overrides: Partial<HerdrPort>): HerdrPort {
  return {
    async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
    async observeRuntime() { return { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" }; },
    async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}, async closePane() {}, ...overrides
  };
}
