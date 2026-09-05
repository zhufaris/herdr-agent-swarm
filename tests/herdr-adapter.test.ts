import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrRetryDelay, HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Herdr adapter structured control", () => {
  afterEach(() => vi.useRealTimers());

  it("backs off busy-pane retries with a one-second ceiling", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => herdrRetryDelay(attempt))).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000]);
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

    await new HerdrCliAdapter(runner, "/opt/shim/herdr", 1000).startAgent("w1:p1", { name: "demo-primary", kind: "traex", executable: "/opt/traex", args: ["--model", "x"] });

    expect(calls[0]).toEqual(["agent", "start", "demo-primary", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto", "--model", "x"]);
    expect(calls[0]?.at(-2)).toBe("--model");
    expect(calls[0]?.at(-1)).toBe("x");
    expect(calls[0]).not.toContainEqual(expect.stringContaining("hooks."));
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
    expect(start).toEqual(["agent", "start", "traex-w1-p1", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--", "--permission-mode", "auto"]);
    expect(start).not.toContainEqual(expect.stringContaining("hooks."));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it.each([
    [{ status: "delivered", operationId: "op-1", turnId: "turn-1" }],
    [{ status: "not-active", reason: "turn changed" }],
    [{ status: "blocked", reason: "approval is active" }],
    [{ status: "unsupported", reason: "native steering unavailable" }],
    [{ status: "delivery-uncertain", operationId: "op-1", reason: "connection lost" }]
  ])("preserves native steering result %j", async (result) => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) { calls.push(args); return json({ type: "agent_steered", ...result }); } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).steerAgent({
      paneId: "w1:p1", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" },
      runtimeTurnId: "turn-1", text: "private steer", idempotencyKey: "message:1"
    })).resolves.toEqual(result);
    expect(calls).toEqual([["agent", "steer", "w1:p1", "private steer", "--turn-id", "turn-1", "--idempotency-key", "message:1", "--agent-session", '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"session-1"}', "--timeout", "1000"]]);
  });

  it("verifies a newly started TraeX agent through targeted agent get when the snapshot is stale", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } });
      if (args[0] === "agent" && args[1] === "get") return json({ agent: { pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" } });
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "/opt/shim/herdr", 1000).startAgent("w1:p1", { name: "demo-primary", kind: "traex", executable: "/opt/traex" })).resolves.toBeUndefined();
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

  it("normalizes a shim-marked native session to TraeX", async () => {
    const native = { async request(method: string) {
      if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle", agent: "codex", display_agent: "traex", agent_session: { source: "herdr-traex-shim", agent: "codex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" } }], agents: [] } };
      throw new Error(`unexpected method: ${method}`);
    } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntime("w1:p1")).resolves.toMatchObject({
      pane: { agentKind: "codex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" } }
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

  it("does not report dispatch when the shim proves no matching TraeX turn started", async () => {
    const onDispatched = vi.fn();
    const runner = { run: vi.fn(async (_command, _args, _timeout, onSpawn) => {
      onSpawn?.();
      throw new Error('Command failed: {"error":{"code":"agent_prompt_not_started","message":"No matching TraeX turn started"}}');
    }) };
    const adapter = new HerdrCliAdapter(runner as never, "herdr", 100);

    await expect(adapter.runPrompt("w1:p1", "/ti", 2_000, undefined, undefined, onDispatched)).rejects.toThrow("agent_prompt_not_started");
    expect(onDispatched).not.toHaveBeenCalled();
  });

  it("queries the model catalog with the exact session fence", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return { stdout: JSON.stringify({ id: "cli:agent:model-list", result: { type: "agent_models", models: [{ id: "one", name: "GPT-5.4", displayName: "GPT 5.4" }] } }), stderr: "" };
    } };
    const session = { source: "herdr-traex-shim", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).listModels("w1:p1", session)).resolves.toEqual([{ id: "one", name: "GPT-5.4", displayName: "GPT 5.4" }]);
    expect(calls).toEqual([["agent", "model-list", "w1:p1", "--agent-session", JSON.stringify(session), "--timeout", "1000"]]);
  });

  it("prepares, checkpoints, and only then commits a model-aware prompt", async () => {
    const events: string[] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      events.push(args[1] === "wait" ? "wait" : String(args[2]));
      if (args[1] === "wait") return { stdout: JSON.stringify({ result: { agent: { agent_status: "done" } } }), stderr: "" };
      const state = args[2] === "prepare" ? "prepared" : "accepted";
      return { stdout: JSON.stringify({ id: "model-prompt", result: { type: "agent_model_prompt", operationId: "a".repeat(64), state, turnId: state === "accepted" ? "turn-1" : null, detail: null } }), stderr: "" };
    } };
    const session = { source: "herdr-traex-shim", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { events.push("dispatched"); }, { modelDispatch: { name: "GPT-5.4", revision: 3 }, agentSession: session, onPrepared: () => { events.push("prepared-fence"); }, onAccepted: ({ turnId }) => { events.push(`accepted:${turnId}`); } })).resolves.toBe("done");
    expect(events).toEqual(["prepare", "prepared-fence", "dispatched", "commit", "accepted:turn-1", "wait"]);
  });

  it("aborts the prepared operation when the durable dispatch checkpoint fails", async () => {
    const events: string[] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      events.push(String(args[2]));
      const state = args[2] === "prepare" ? "prepared" : "rejected";
      return { stdout: JSON.stringify({ id: "model-prompt", result: { type: "agent_model_prompt", operationId: "a".repeat(64), state, turnId: null, detail: null } }), stderr: "" };
    } };
    const session = { source: "herdr-traex-shim", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
    const onAborted = vi.fn();

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { throw new Error("dispatch checkpoint failed"); }, {
      modelDispatch: { name: "GPT-5.4", revision: 3 }, agentSession: session, onPrepared() {}, onPrepareAborted: onAborted
    })).rejects.toThrow("dispatch checkpoint failed");
    expect(events).toEqual(["prepare", "abort"]);
    expect(onAborted).toHaveBeenCalledWith("a".repeat(64));
  });

  it("reports dispatch only after successful prompt completion", async () => {
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    let runnerSettled = false;
    let dispatched = 0;
    const runner: CommandRunner = { async run(_executable, _args, _timeout, onStarted) {
      await onStarted?.();
      await completion;
      runnerSettled = true;
      return { stdout: JSON.stringify({ result: { prompt: { agent_status: "done" } } }), stderr: "" };
    } };

    const prompt = new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 2000, undefined, undefined, () => { dispatched += 1; });
    await Promise.resolve();
    expect(dispatched).toBe(0);
    expect(runnerSettled).toBe(false);
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
