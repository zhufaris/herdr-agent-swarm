import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrRetryDelay, HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

describe("Herdr adapter structured control", () => {
  afterEach(() => vi.useRealTimers());

  it("backs off busy-pane retries with a one-second ceiling", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => herdrRetryDelay(attempt))).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000]);
  });

  it("passes prompt cancellation to the command runner", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const runner: CommandRunner = { async run(_executable, args, _timeout, _started, signal) {
      signals.push(signal);
      if (args[1] === "prompt") return { stdout: JSON.stringify({ state: "working" }), stderr: "" };
      controller.abort(new Error("shutdown"));
      signal?.throwIfAborted();
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, controller.signal)).rejects.toThrow("shutdown");
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("rejects a configured workspace whose live Space label differs", async () => {
    const runner: CommandRunner = { async run() {
      return json({ workspace: { workspace_id: "wH", label: "herdr-lark-bridge" } });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).assertWorkspace("wH", "herdr-agent-swarm"))
      .rejects.toThrow("Project Space mismatch: workspace wH is 'herdr-lark-bridge', expected 'herdr-agent-swarm'");
  });

  it("starts managed TraeX through the formal agent command", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" }], agents: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "/opt/herdr/bin/herdr", 1000).startAgent("w1:p1", { name: "demo-primary", kind: "traex", executable: "/opt/traex", args: ["--model", "x"] });

    expect(calls[0]).toEqual(["agent", "start", "demo-primary", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto", "--model", "x"]);
    expect(calls[0]?.at(-2)).toBe("--model");
    expect(calls[0]?.at(-1)).toBe("x");
    expect(calls[0]).not.toContainEqual(expect.stringContaining("hooks."));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it("can omit the configured permission mode for a sandbox-constrained TraeX agent", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" }], agents: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "/opt/herdr/bin/herdr", 1000).startAgent("w1:p1", { name: "controller", kind: "traex", executable: "/opt/traex", args: ["--sandbox", "read-only"], useConfiguredPermissionMode: false });

    expect(calls[0]).toEqual(["agent", "start", "controller", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--sandbox", "read-only"]);
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

    await new HerdrCliAdapter(runner, "/opt/herdr/bin/herdr", 1000).startTraex("w1:p1", "/opt/traex");

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).toEqual(["agent", "start", "traex-w1-p1", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto"]);
    expect(start).not.toContainEqual(expect.stringContaining("hooks."));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it("revalidates the exact native turn before sending ctrl+c", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get") return json({ agent: {
        pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "working", active_turn_id: "turn-1",
        steering_capability: "native", agent_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      } });
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).interruptAgent({
      paneId: "w1:p1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      runtimeTurnId: "turn-1", idempotencyKey: "control-1"
    })).resolves.toEqual({ status: "interrupted" });
    expect(calls).toEqual([["agent", "get", "w1:p1"], ["agent", "send-keys", "w1:p1", "ctrl+c"]]);
  });

  it("rejects a native Herdr TraeX source when interrupting a legacy-owned turn", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get") return json({ agent: {
        pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "working", active_turn_id: "turn-1",
        agent_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      } });
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).interruptAgent({
      paneId: "w1:p1", agentSession: { source: "herdr:codex", agent: "traex", kind: "id", value: "session-1" },
      runtimeTurnId: "turn-1", idempotencyKey: "control-1"
    })).resolves.toEqual({ status: "not-active", reason: "Agent session identity changed" });
    expect(calls).toEqual([["agent", "get", "w1:p1"]]);
  });

  it("does not interrupt when the native runtime turn changed", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return json({ agent: {
        pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "working", active_turn_id: "turn-2",
        steering_capability: "native", agent_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      } });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).interruptAgent({
      paneId: "w1:p1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      runtimeTurnId: "turn-1", idempotencyKey: "control-1"
    })).resolves.toMatchObject({ status: "not-active", reason: expect.stringContaining("changed") });
    expect(calls).toEqual([["agent", "get", "w1:p1"]]);
  });

  it("verifies a newly started TraeX agent through targeted agent get when the snapshot is stale", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } });
      if (args[0] === "agent" && args[1] === "get") return json({ agent: { pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" } });
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "/opt/herdr/bin/herdr", 1000).startAgent("w1:p1", { name: "demo-primary", kind: "traex", executable: "/opt/traex" })).resolves.toBeUndefined();
    expect(calls).toContainEqual(["agent", "get", "w1:p1"]);
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

  it.each([
    "agent_pane_busy",
    "agent_start_failed: Pane w1:p1 is not an available shell"
  ])("retries agent start while a new pane shell is not ready: %s", async (readinessError) => {
    let starts = 0;
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "agent" && args[1] === "start" && starts++ === 0) throw new Error(readinessError);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" }], agents: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "herdr", 1000).startAgent("w1:p1", { name: "primary", kind: "codex", executable: "codex" });
    expect(starts).toBe(2);
  });

  it("does not retry an uncertain agent start", async () => {
    let starts = 0;
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "agent" && args[1] === "start") {
        starts += 1;
        throw new Error("agent_start_uncertain: TraeX may have started in pane w1:p1");
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).startAgent("w1:p1", { name: "primary", kind: "traex", executable: "traex" }))
      .rejects.toThrow("agent_start_uncertain");
    expect(starts).toBe(1);
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

  it("observes multiple runtimes from one snapshot with bounded process probes", async () => {
    let active = 0; let peak = 0;
    const native = { request: vi.fn(async (method: string, params: { pane_id?: string }) => {
      if (method === "session.snapshot") return { snapshot: { panes: Array.from({ length: 6 }, (_, index) => ({ pane_id: `w1:p${index}`, workspace_id: "w1", agent_status: "unknown" })), agents: [] } };
      if (method === "pane.process_info") { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return { process_info: { foreground_processes: [{ name: "traex" }] } }; }
      throw new Error(`unexpected method: ${method}:${params.pane_id}`);
    }) };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    const observations = await new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntimes!(["w1:p0", "w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5"]);

    expect(native.request.mock.calls.filter(([method]) => method === "session.snapshot")).toHaveLength(1);
    expect(native.request.mock.calls.filter(([method]) => method === "pane.process_info")).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(4);
    expect(observations.size).toBe(6);
  });

  it("temporarily bypasses a failing native transport and probes it after cooldown", async () => {
    let now = 0;
    const native = { request: vi.fn(async () => { throw new Error("native unavailable"); }) };
    const runner: CommandRunner = { async run(_executable, args) {
      expect(args).toEqual(["api", "snapshot"]);
      return json({ snapshot: { panes: [], agents: [] } });
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000, "auto", native, { nativeFailureThreshold: 2, nativeOpenMs: 100, now: () => now });

    await adapter.listAllPanes();
    await adapter.listAllPanes();
    await adapter.listAllPanes();
    expect(native.request).toHaveBeenCalledTimes(2);
    expect(adapter.nativeTransportStatus()).toMatchObject({ state: "open", consecutiveFailures: 2 });

    now = 101;
    await adapter.listAllPanes();
    expect(native.request).toHaveBeenCalledTimes(3);
  });

  it("closes the native transport circuit after a successful recovery probe", async () => {
    let now = 0; let fail = true;
    const native = { request: vi.fn(async () => { if (fail) throw new Error("native unavailable"); return { snapshot: { panes: [], agents: [] } }; }) };
    const runner: CommandRunner = { async run() { return json({ snapshot: { panes: [], agents: [] } }); } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000, "auto", native, { nativeFailureThreshold: 1, nativeOpenMs: 100, now: () => now });

    await adapter.listAllPanes();
    now = 101; fail = false;
    await adapter.listAllPanes();

    expect(adapter.nativeTransportStatus()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
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

  it("preserves a legacy shim snapshot without normalizing its identity", async () => {
    const native = { async request(method: string) {
      if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle", agent: "codex", display_agent: "traex", agent_session: { source: "herdr-traex-shim", agent: "codex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" } }], agents: [] } };
      throw new Error(`unexpected method: ${method}`);
    } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntime("w1:p1")).resolves.toMatchObject({
      traexProcess: false, pane: { agentKind: "codex", agentSession: { source: "herdr-traex-shim", agent: "codex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" } }
    });
  });

  it("waits for a new prompt lifecycle before waiting separately for completion", async () => {
    const calls: string[][] = [];
    const observations: object[] = [];
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, args, timeout, onStarted) {
      calls.push(args);
      expect(timeout).toBe(args[1] === "prompt" ? 2000 : 3000);
      await onStarted?.();
      return { stdout: JSON.stringify({ result: { prompt: { agent_status: args[1] === "prompt" ? "working" : "done" } } }), stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, (value) => { observations.push(value); }, undefined, () => { dispatched += 1; })).resolves.toBe("done");
    expect(calls).toEqual([
      ["agent", "prompt", "w1:p1", "hello", "--wait", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", "1000"],
      ["agent", "wait", "w1:p1", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "2000"]
    ]);
    expect(observations).toEqual([
      { state: "working", stateSource: "structured" },
      { state: "working", stateSource: "structured" },
      { state: "done", stateSource: "structured" }
    ]);
    expect(dispatched).toBe(1);
  });

  it("does not report dispatch when Herdr proves no matching TraeX turn started", async () => {
    const onDispatched = vi.fn();
    const runner = { run: vi.fn(async (_command, _args, _timeout, onSpawn) => {
      onSpawn?.();
      throw new Error('Command failed: {"error":{"code":"agent_prompt_not_started","message":"No matching TraeX turn started"}}');
    }) };
    const adapter = new HerdrCliAdapter(runner as never, "herdr", 100);

    await expect(adapter.runPrompt("w1:p1", "/ti", 2_000, undefined, undefined, onDispatched)).rejects.toThrow("agent_prompt_not_started");
    expect(onDispatched).not.toHaveBeenCalled();
  });

  it("does not report dispatch when fenced sanitation rejects before prompt submission", async () => {
    const onDispatched = vi.fn();
    const runner = { run: vi.fn(async (_command, _args, _timeout, onSpawn) => {
      onSpawn?.();
      throw new Error('{"error":{"code":"agent_prompt_rejected","message":"Target is not settled"}}');
    }) };
    const adapter = new HerdrCliAdapter(runner as never, "herdr", 100);

    await expect(adapter.runPrompt("w1:p1", "hello", 2_000, undefined, undefined, onDispatched)).rejects.toThrow("agent_prompt_rejected");
    expect(onDispatched).not.toHaveBeenCalled();
  });

  it("reports dispatch after prompt acceptance before waiting for completion", async () => {
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const calls: string[][] = [];
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, args, _timeout, onStarted) {
      calls.push(args);
      await onStarted?.();
      if (args[1] === "prompt") return { stdout: JSON.stringify({ result: { prompt: { agent_status: "working" } } }), stderr: "" };
      await completion;
      return { stdout: JSON.stringify({ result: { agent: { agent_status: "done" } } }), stderr: "" };
    } };

    const prompt = new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; });
    await vi.waitFor(() => expect(dispatched).toBe(1));
    expect(calls).toEqual([
      ["agent", "prompt", "w1:p1", "hello", "--wait", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", "1000"],
      ["agent", "wait", "w1:p1", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "2000"]
    ]);
    releaseCompletion();

    await expect(prompt).resolves.toBe("done");
    expect(dispatched).toBe(1);
  });

  it("propagates an asynchronous dispatch callback failure without reporting twice", async () => {
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, _args, _timeout, onStarted) {
      await onStarted?.();
      return { stdout: JSON.stringify({ result: { prompt: { agent_status: "done" } } }), stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, async () => {
      dispatched += 1;
      throw new Error("dispatch checkpoint failed");
    })).rejects.toThrow("dispatch checkpoint failed");
    expect(dispatched).toBe(1);
  });

  it("normalizes structured idle prompt completion to done", async () => {
    const runner: CommandRunner = { async run() { return { stdout: JSON.stringify({ result: { agent: { state: "idle" } } }), stderr: "" }; } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000)).resolves.toBe("done");
  });

  it.each(["agent_not_found", "agent_not_ready", "agent_blocked"])("does not mark explicit pre-dispatch %s as dispatched after process spawn", async (code) => {
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, _args, _timeout, onStarted) { await onStarted?.(); throw new Error(JSON.stringify({ error: { code } })); } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; })).rejects.toThrow(code);
    expect(dispatched).toBe(0);
  });

  it("leaves durable dispatch provenance empty after an explicit post-spawn rejection", async () => {
    const store = new SqliteBindingStore(":memory:");
    try {
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
      store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
      const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
      store.claimNextDispatchablePrompt("b1");
      const runner: CommandRunner = { async run(_executable, _args, _timeout, onStarted) {
        await onStarted?.();
        throw new Error('{"error":{"code":"agent_not_ready"}}');
      } };

      await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => {
        store.markPromptDispatched("p1", "2026-08-30T00:00:01.000Z");
      })).rejects.toThrow("agent_not_ready");
      expect(store.getPrompt("p1")).toMatchObject({ state: "running", observationState: "not_started", dispatchedAt: null });
    } finally {
      store.close();
    }
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

  it("waits for a native close event before one authoritative verification", async () => {
    const requests: string[] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "pane" && args[1] === "close") return { stdout: "", stderr: "" };
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    } };
    const native = {
      async request(method: string) { requests.push(method); return { snapshot: { panes: [], agents: [] } }; },
      waitForPaneEvent: vi.fn(async () => true)
    };

    await new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).closePane("w1:p1");

    expect(native.waitForPaneEvent).toHaveBeenCalledWith("w1:p1", 1000);
    expect(requests).toEqual(["session.snapshot"]);
  });

  it("creates a dedicated Lark tab without stealing focus", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "tab") return json({ root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo" } });
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };
    await new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", { bindingId: "b1", generation: 1, projectId: "repo", placement: "dedicated-tab", title: "ilcs" });
    expect(calls[0]).toContain("--no-focus");
    expect(calls[0]).toContain("lark_ilcs");
  });

  it("does not duplicate the Lark tab prefix when a Worker title already has it", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "tab") return json({ root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo" } });
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };
    await new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", { bindingId: "b1", generation: 1, projectId: "repo", placement: "dedicated-tab", title: "lark_primary-reviewer", titlePolicy: "complete" });
    expect(calls[0]).toContain("lark_primary-reviewer");
    expect(calls[0]).not.toContain("lark_lark_primary-reviewer");
  });
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
