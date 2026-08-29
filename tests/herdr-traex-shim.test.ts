import { describe, expect, it } from "vitest";
import { encodeLaunchRequest, parseHerdrShimInvocation, runHerdrTraexStart, TraexStartError, validateShimPaths } from "../src/runtime/herdr-traex-shim.js";

describe("Herdr TraeX shim invocation", () => {
  it.each([
    [["agent", "list"]],
    [["agent", "start", "reviewer", "--kind", "codex", "--pane", "w1:p1"]],
    [["--session", "test", "agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"]],
    [["--remote", "host", "agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"]]
  ])("delegates non-exact invocation %j unchanged", (argv) => {
    expect(parseHerdrShimInvocation(argv)).toEqual({ kind: "delegate", argv });
  });

  it("parses the exact local TraeX start and preserves trailing argv", () => {
    expect(parseHerdrShimInvocation([
      "agent", "start", "reviewer", "--pane", "w1:p1", "--kind", "traex", "--timeout", "45000",
      "--", "--model", "GPT 5", "--config=x=y"
    ])).toEqual({
      kind: "start-traex", name: "reviewer", paneId: "w1:p1", timeoutMs: 45000,
      traexArgs: ["--model", "GPT 5", "--config=x=y"]
    });
  });

  it("defaults the timeout to the native 30 seconds", () => {
    expect(parseHerdrShimInvocation(["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"])).toMatchObject({ timeoutMs: 30000 });
  });

  it.each([
    [["agent", "start", "--kind", "traex", "--pane", "w1:p1"], /name/],
    [["agent", "start", "reviewer", "--kind", "traex"], /pane/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--pane", "w1:p2"], /duplicate.*pane/i],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--timeout", "0"], /timeout/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--timeout", "300001"], /timeout/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--bogus"], /unknown/i],
    [["agent", "start", "reviewer", "--kind", "traex", "--kind", "traex", "--pane", "w1:p1"], /duplicate.*kind/i]
  ])("rejects malformed exact TraeX start %j", (argv, error) => {
    expect(() => parseHerdrShimInvocation(argv)).toThrow(error);
  });

  it("rejects unsafe executable configuration", () => {
    expect(() => validateShimPaths({ realHerdr: "herdr", traex: "/bin/traex", shim: "/opt/shim/herdr", installVersion: "1", validatedHerdrVersion: "0.7.5" })).toThrow(/absolute/);
    expect(() => validateShimPaths({ realHerdr: "/opt/shim/herdr", traex: "/bin/traex", shim: "/opt/shim/herdr", installVersion: "1", validatedHerdrVersion: "0.7.5" })).toThrow(/different/);
  });
});

describe("Herdr TraeX managed start", () => {
  it("encodes executable and arguments without losing boundaries", () => {
    expect(encodeLaunchRequest("/opt/traex", ["--model", "GPT 5", "x=y"]).equals(
      Buffer.from("/opt/traex\0--model\0GPT 5\0x=y\0")
    )).toBe(true);
  });

  it("launches once, fences the process, and waits for managed identity", async () => {
    const calls: string[][] = [];
    let processReads = 0;
    let agentReads = 0;
    const reports: unknown[] = [];
    const result = await runHerdrTraexStart(
      { name: "reviewer", paneId: "w1:p1", timeoutMs: 1000, traexArgs: ["--model", "private model"] },
      { realHerdr: "/opt/herdr", traex: "/opt/traex", launcher: "/opt/shim/pane-launcher", reporter: "/opt/shim/reporter.js", requestDir: "/run/user/1/shim", validatedHerdrVersion: "0.7.5" },
      {
        runHerdr: async (args) => {
          calls.push(args);
          if (args[0] === "--version") return { stdout: "herdr 0.7.5\n", stderr: "" };
          if (args[0] === "pane" && args[1] === "process-info") {
            processReads += 1;
            return { stdout: envelope(processReads === 1 ? processInfo(10, "bash", ["bash"]) : processInfo(44, "traex", ["/opt/traex"])), stderr: "" };
          }
          if (args[0] === "agent" && args[1] === "get") {
            agentReads += 1;
            return { stdout: envelope({ agent: { pane_id: "w1:p1", name: "reviewer", agent: "traex", agent_status: agentReads > 1 ? "idle" : "unknown" } }), stderr: "" };
          }
          return { stdout: envelope({}), stderr: "" };
        },
        writeRequest: async (bytes) => { reports.push(bytes); return "abc-123"; },
        removeRequest: async () => undefined,
        processStartTicks: async () => "987",
        startReporter: (input) => { reports.push(input); },
        sleep: async () => undefined,
        now: (() => { let now = 0; return () => ++now; })()
      }
    );

    expect(result).toMatchObject({ agent: { name: "reviewer", agent: "traex", agent_status: "idle" } });
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "run")).toEqual([["pane", "run", "w1:p1", "/opt/shim/pane-launcher", "abc-123"]]);
    expect(calls.flat()).not.toContain("private model");
    expect(reports[1]).toMatchObject({ paneId: "w1:p1", pid: 44, processStartTicks: "987" });
  });

  it("rejects a busy pane before writing or launching", async () => {
    let wrote = false;
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      return { stdout: envelope(processInfo(12, "vim", ["vim"])), stderr: "" };
    }, () => { wrote = true; });
    await expect(runHerdrTraexStart(startInput(), startConfig(), dependencies)).rejects.toThrow(/available shell/);
    expect(wrote).toBe(false);
  });

  it("marks failure after pane run as uncertain and never retries the launch", async () => {
    let launches = 0;
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      if (args[0] === "pane" && args[1] === "run") { launches += 1; return { stdout: envelope({}), stderr: "" }; }
      return { stdout: envelope(processInfo(10, "bash", ["bash"])), stderr: "" };
    });
    await expect(runHerdrTraexStart(startInput(), startConfig(), dependencies)).rejects.toMatchObject<TraexStartError>({ code: "agent_start_uncertain" });
    expect(launches).toBe(1);
  });
});

function envelope(result: unknown): string { return JSON.stringify({ id: "test", result }); }
function processInfo(pid: number, name: string, argv: string[]): object {
  return { process_info: { shell_pid: 10, foreground_processes: [{ pid, name, argv }] } };
}
function startInput() { return { name: "reviewer", paneId: "w1:p1", timeoutMs: 5, traexArgs: [] }; }
function startConfig() { return { realHerdr: "/opt/herdr", traex: "/opt/traex", launcher: "/opt/shim/pane-launcher", reporter: "/opt/shim/reporter.js", requestDir: "/run/user/1/shim", validatedHerdrVersion: "0.7.5" }; }
function fakeStartDependencies(runHerdr: (args: string[]) => Promise<{ stdout: string; stderr: string }>, onWrite = () => undefined) {
  return { runHerdr, writeRequest: async () => { onWrite(); return "abc"; }, removeRequest: async () => undefined, processStartTicks: async () => null, startReporter: () => undefined, sleep: async () => undefined, now: (() => { let now = 0; return () => ++now; })() };
}
