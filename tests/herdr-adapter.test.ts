import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

describe("Herdr adapter structured control", () => {
  afterEach(() => vi.useRealTimers());

  it("starts managed TraeX through the formal agent command", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" }], agents: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "/opt/shim/herdr", 1000).startAgent("w1:p1", { name: "demo-primary", kind: "traex", executable: "/opt/traex", args: ["--model", "x"] });

    expect(calls[0]?.slice(0, 12)).toEqual(["agent", "start", "demo-primary", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto"]);
    expect(calls[0]?.at(-2)).toBe("--model");
    expect(calls[0]?.at(-1)).toBe("x");
    expect(calls[0]).toContainEqual(expect.stringContaining("hooks.UserPromptSubmit"));
    expect(calls[0]).toContainEqual(expect.stringContaining("hooks.Stop"));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it("uses the formal TraeX agent command for compatibility bridge startup", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") {
        const started = calls.some((call) => call[0] === "agent" && call[1] === "start");
        return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: started ? "idle" : "unknown", agent: started ? "traex" : null }], agents: [] } });
      }
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "/opt/shim/herdr", 1000).startTraex("w1:p1", "/opt/traex");

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start?.slice(0, 13)).toEqual(["agent", "start", "traex-w1-p1", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto", "--dangerously-bypass-hook-trust"]);
    expect(start).toContainEqual(expect.stringContaining("hooks.SessionStart"));
    expect(start).toContainEqual(expect.stringContaining("hooks.UserPromptSubmit"));
    expect(start).toContainEqual(expect.stringContaining("hooks.Stop"));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it("starts supported native agents and forwards argv without shell interpolation", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" }], agents: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }] } });
      return { stdout: "", stderr: "" };
    } };
    const forwarded = ["-c", 'mcp_servers.bridge.command="node"'];

    await new HerdrCliAdapter(runner, "herdr", 1000).startAgent("w1:p1", { name: "primary", kind: "codex", executable: "codex", args: forwarded });

    expect(calls[0]).toEqual(["agent", "start", "primary", "--kind", "codex", "--pane", "w1:p1", "--timeout", "1000", "--", ...forwarded]);
  });

  it("retries agent start only while a new pane shell is busy", async () => {
    let starts = 0;
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "agent" && args[1] === "start" && starts++ === 0) throw new Error("agent_pane_busy");
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" }], agents: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "herdr", 1000).startAgent("w1:p1", { name: "primary", kind: "codex", executable: "codex" });
    expect(starts).toBe(2);
  });

  it("derives runtime readiness only from structured state and process metadata", async () => {
    const native = { async request(method: string) {
      if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } };
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ name: "traex" }] } };
      throw new Error(`unexpected method: ${method}`);
    } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntime("w1:p1")).resolves.toMatchObject({
      traexProcess: true, composerReady: false, evidenceSource: "process", pane: { agentState: "unknown", foregroundExecutables: ["traex"] }
    });
  });

  it("treats structured done as ready without reading terminal content", async () => {
    const native = { async request(method: string) {
      if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", agent: "traex" }], agents: [] } };
      throw new Error(`unexpected method: ${method}`);
    } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntime("w1:p1")).resolves.toMatchObject({
      traexProcess: true, composerReady: true, evidenceSource: "structured", pane: { agentState: "done" }
    });
  });

  it("submits prompts through agent prompt --wait and emits structured completion", async () => {
    const calls: string[][] = [];
    const observations: object[] = [];
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, args, timeout, onStarted) {
      calls.push(args);
      expect(timeout).toBe(3000);
      await onStarted?.();
      return { stdout: JSON.stringify({ result: { prompt: { agent_status: "done" } } }), stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, (value) => { observations.push(value); }, undefined, () => { dispatched += 1; })).resolves.toBe("done");
    expect(calls).toEqual([["agent", "prompt", "w1:p1", "hello", "--wait", "--timeout", "2000"]]);
    expect(observations).toEqual([{ state: "done", stateSource: "structured" }]);
    expect(dispatched).toBe(1);
  });

  it("normalizes structured idle prompt completion to done", async () => {
    const runner: CommandRunner = { async run() { return { stdout: JSON.stringify({ result: { agent: { state: "idle" } } }), stderr: "" }; } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000)).resolves.toBe("done");
  });

  it.each(["agent_not_found", "agent_not_ready", "agent_blocked"])("does not mark explicit pre-dispatch %s as dispatched", async (code) => {
    let dispatched = 0;
    const runner: CommandRunner = { async run() { throw new Error(JSON.stringify({ error: { code } })); } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; })).rejects.toThrow(code);
    expect(dispatched).toBe(0);
  });

  it("marks a stalled native prompt as possibly dispatched to prevent replay", async () => {
    let dispatched = 0;
    const runner: CommandRunner = { async run() { throw new Error('{"error":{"code":"agent_prompt_stalled"}}'); } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; })).rejects.toThrow("agent_prompt_stalled");
    expect(dispatched).toBe(1);
  });

  it("marks transport failure after process start as possibly dispatched", async () => {
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, _args, _timeout, onStarted) { await onStarted?.(); throw new Error("transport failed"); } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; })).rejects.toThrow("transport failed");
    expect(dispatched).toBe(1);
  });

  it("sends escape through the native Agent surface", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) { calls.push(args); return { stdout: "", stderr: "" }; } };
    await new HerdrCliAdapter(runner, "herdr", 1000).sendEscape("w1:p1");
    expect(calls).toEqual([["agent", "send-keys", "w1:p1", "esc"]]);
  });

  it("creates a dedicated Lark tab without stealing focus", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "tab") return json({ root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo" } });
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };
    await new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", { bindingId: "b1", generation: 1, projectId: "repo", placement: "dedicated-tab", title: "task" });
    expect(calls[0]).toContain("--no-focus");
    expect(calls[0]).toContain("lark_task");
  });
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
