import { describe, expect, it, vi } from "vitest";
import { reportAgentArguments, reportAgentSessionArguments } from "../src/cli/herdr-traex-reporter.js";
import { TraexAgentReporter, type ReporterOperations } from "../src/runtime/herdr-traex-reporter.js";

const input = { paneId: "w1:p1", name: "reviewer", executable: "/opt/traex", pid: 44, processStartTicks: "987", agentSessionId: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };

describe("TraeX metadata reporter", () => {
  it("uses separate trusted authorities for state and session identity", () => {
    expect(reportAgentArguments("w1:p1", "idle", "41")).toEqual([
      "pane", "report-agent", "w1:p1", "--source", "herdr-traex-shim", "--agent", "codex", "--state", "idle", "--seq", "41"
    ]);
    expect(reportAgentSessionArguments("w1:p1", "42", input.agentSessionId)).toEqual([
      "pane", "report-agent-session", "w1:p1", "--source", "herdr:codex", "--agent", "codex", "--seq", "42",
      "--agent-session-id", input.agentSessionId, "--session-start-source", "startup"
    ]);
  });

  it("publishes initial idle authority, display metadata, and the managed name", async () => {
    const operations = fakeOperations();

    await expect(new TraexAgentReporter(operations, { pollIntervalMs: 1, maxCycles: 1 }).run(input)).resolves.toBe("released");
    expect(operations.reportMetadata).toHaveBeenCalledOnce();
    expect(operations.reportAgent).toHaveBeenCalledWith("w1:p1", "idle", expect.any(String));
    expect(operations.reportAgentSession).toHaveBeenCalledWith("w1:p1", expect.any(String), "01a03eb1-c193-7531-83c0-e6c6f70143d4");
    expect(operations.renameAgent).toHaveBeenCalledOnce();
    expect(operations.renameAgent).toHaveBeenCalledWith("w1:p1", "reviewer");
    expect(operations.releaseAgent).toHaveBeenCalledWith("w1:p1", "herdr-traex-shim", "codex", expect.any(String));
    expect(operations.clearMetadata).toHaveBeenCalledWith("w1:p1", expect.any(String));
  });

  it("stops on changed process identity without reading terminal content", async () => {
    const operations = fakeOperations({ processIdentity: vi.fn(async () => ({ executable: "/opt/traex", pid: 44, startTicks: "different" })) });
    await expect(new TraexAgentReporter(operations).run(input)).resolves.toBe("lost-pane");
    expect(operations.reportAgent).not.toHaveBeenCalled();
    expect(operations.releaseAgent).toHaveBeenCalledOnce();
  });

  it("does not publish an invalid session identity", async () => {
    const operations = fakeOperations();
    await expect(new TraexAgentReporter(operations).run({ ...input, agentSessionId: "latest" })).rejects.toThrow(/session identity/i);
    expect(operations.reportAgent).not.toHaveBeenCalled();
    expect(operations.reportAgentSession).not.toHaveBeenCalled();
  });

  it("clears metadata after an authority report error", async () => {
    const operations = fakeOperations({ reportAgent: vi.fn(async () => { throw new Error("report failed"); }) });
    await expect(new TraexAgentReporter(operations).run(input)).rejects.toThrow("report failed");
    expect(operations.releaseAgent).toHaveBeenCalledOnce();
    expect(operations.clearMetadata).toHaveBeenCalledOnce();
  });

  it("releases shim authority when trusted session reporting fails", async () => {
    const operations = fakeOperations({ reportAgentSession: vi.fn(async () => { throw new Error("session report failed"); }) });
    await expect(new TraexAgentReporter(operations).run(input)).rejects.toThrow("session report failed");
    expect(operations.releaseAgent).toHaveBeenCalledOnce();
    expect(operations.clearMetadata).toHaveBeenCalledOnce();
    expect(operations.renameAgent).not.toHaveBeenCalled();
  });

  it("emits distinct decimal metadata lifecycle sequences", async () => {
    const operations = fakeOperations();
    await new TraexAgentReporter(operations, { maxCycles: 1, pollIntervalMs: 1, sequence: (() => { let value = 10n; return () => ++value; })() }).run(input);
    const sequences = [operations.reportMetadata.mock.calls[0]![1], operations.releaseAgent.mock.calls[0]![3], operations.clearMetadata.mock.calls[0]![1]].map(BigInt);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

function fakeOperations(overrides: Partial<ReporterOperations> = {}) {
  return {
    processIdentity: vi.fn(async () => ({ executable: "/opt/traex", pid: 44, startTicks: "987" })),
    reportMetadata: vi.fn(async () => undefined),
    reportAgent: vi.fn(async () => undefined),
    reportAgentSession: vi.fn(async () => undefined),
    renameAgent: vi.fn(async () => undefined),
    releaseAgent: vi.fn(async () => undefined),
    clearMetadata: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    ...overrides
  };
}
