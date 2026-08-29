import { describe, expect, it, vi } from "vitest";
import { TraexAgentReporter, type ReporterOperations } from "../src/runtime/herdr-traex-reporter.js";

const input = { paneId: "w1:p1", name: "reviewer", executable: "/opt/traex", pid: 44, processStartTicks: "987" };

describe("TraeX authority reporter", () => {
  it("reports only normalized state transitions and renames after readiness", async () => {
    const states = ["unknown", "unknown", "working", "working", "blocked", "idle"] as const;
    let index = 0;
    const operations = fakeOperations({
      explainCodexSnapshot: vi.fn(async () => states[Math.min(index++, states.length - 1)]!),
      processIdentity: vi.fn(async () => index <= states.length ? { executable: "/opt/traex", pid: 44, startTicks: "987" } : null)
    });
    const reporter = new TraexAgentReporter(operations, { pollIntervalMs: 1, maxCycles: states.length });

    await expect(reporter.run(input)).resolves.toBe("released");
    expect(operations.reportAgent).toHaveBeenCalledTimes(4);
    expect(operations.reportAgent.mock.calls.map((call) => call[1])).toEqual(["unknown", "working", "blocked", "idle"]);
    expect(operations.renameAgent).toHaveBeenCalledTimes(1);
    expect(operations.renameAgent).toHaveBeenCalledWith("w1:p1", "reviewer");
    expect(operations.releaseAgent).toHaveBeenCalledWith("w1:p1", "herdr-traex-shim", "traex", expect.any(String));
  });

  it("maps unsupported explanation output to unknown and never reports done", async () => {
    const operations = fakeOperations({ explainCodexSnapshot: vi.fn(async () => "done") });
    await new TraexAgentReporter(operations, { pollIntervalMs: 1, maxCycles: 1 }).run(input);
    expect(operations.reportAgent).toHaveBeenCalledWith("w1:p1", "unknown", expect.any(String));
    expect(operations.reportAgent).not.toHaveBeenCalledWith("w1:p1", "done", expect.any(String));
  });

  it("stops on a changed process identity and releases only shim authority", async () => {
    const operations = fakeOperations({ processIdentity: vi.fn(async () => ({ executable: "/opt/traex", pid: 44, startTicks: "different" })) });
    await expect(new TraexAgentReporter(operations).run(input)).resolves.toBe("lost-pane");
    expect(operations.explainCodexSnapshot).not.toHaveBeenCalled();
    expect(operations.releaseAgent).toHaveBeenCalledWith("w1:p1", "herdr-traex-shim", "traex", expect.any(String));
  });

  it("releases authority after an observation error", async () => {
    const operations = fakeOperations({ explainCodexSnapshot: vi.fn(async () => { throw new Error("read failed"); }) });
    await expect(new TraexAgentReporter(operations).run(input)).rejects.toThrow("read failed");
    expect(operations.releaseAgent).toHaveBeenCalledTimes(1);
  });

  it("emits strictly increasing decimal sequence values", async () => {
    const operations = fakeOperations();
    await new TraexAgentReporter(operations, { maxCycles: 2, pollIntervalMs: 1, sequence: (() => { let value = 10n; return () => ++value; })() }).run(input);
    const sequences = [
      ...operations.reportAgent.mock.calls.map((call) => call[2] as string),
      ...operations.releaseAgent.mock.calls.map((call) => call[3] as string)
    ].map(BigInt);
    expect(sequences).toEqual([...sequences].sort((a, b) => a < b ? -1 : 1));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

function fakeOperations(overrides: Partial<ReporterOperations> = {}) {
  return {
    processIdentity: vi.fn(async () => ({ executable: "/opt/traex", pid: 44, startTicks: "987" })),
    readPane: vi.fn(async () => "bounded terminal snapshot"),
    explainCodexSnapshot: vi.fn(async () => "idle"),
    reportAgent: vi.fn(async () => undefined),
    renameAgent: vi.fn(async () => undefined),
    releaseAgent: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    ...overrides
  };
}
