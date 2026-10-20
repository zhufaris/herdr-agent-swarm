import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrRetryDelay, HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import { HerdrEventsAdapter } from "../src/adapters/herdr-events-adapter.js";
import { CommandError, type CommandRunner } from "../src/infra/command-runner.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

const IDENTITY_RECONCILE_HELP = "herdr pane identity-reconcile --operation-id ID --expected-pane ID --expected-terminal ID --expected-workspace ID --expected-token TOKEN --target-workspace ID --expected-workspace-label TEXT --token TOKEN";

describe("Herdr adapter structured control", () => {
  afterEach(() => vi.useRealTimers());

  it("locates an active TraeX turn from durable events when the pane snapshot omits active_turn_id", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get") return json({ agent: {
        pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", agent: "traex", agent_status: "working",
        agent_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      } });
      if (args[0] === "agent" && args[1] === "events" && args[2] === "turns") return json({ turns: [
        { turn_id: "completed", started_at: "2026-10-12T11:00:00.000Z", terminal_state: "completed" },
        { turn_id: "active", started_at: "2026-10-12T11:01:00.000Z" }
      ] });
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).getActiveTurn("w1:p1")).resolves.toEqual({
      turnId: "active", startedAt: "2026-10-12T11:01:00.000Z"
    });
    expect(calls).toEqual([
      ["agent", "get", "w1:p1"],
      ["agent", "events", "turns", "--kind", "traex", "--session-id", "session-1", "--limit", "128"]
    ]);
  });

  it("backs off busy-pane retries with a one-second ceiling", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => herdrRetryDelay(attempt))).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000]);
  });

  it("parses native pane tokens and ignores malformed values", async () => {
    const native = { async request() { return { snapshot: { panes: [
      { pane_id: "w1:p1", token: "VDFN", workspace_id: "w1" },
      { pane_id: "w1:p2", token: "not-a-token", workspace_id: "w1" },
      { pane_id: "w1:p3", workspace_id: "w1" },
      { pane_id: "w1:p4", token: "invalid", workspace_id: "w1" }
    ], agents: [{ pane_id: "w1:p4", token: "a1b2", workspace_id: "w1", agent: "traex" }] } }; } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).listAllPanes()).resolves.toMatchObject([
      { paneId: "w1:p1", paneToken: "vdfn" },
      { paneId: "w1:p2", paneToken: null },
      { paneId: "w1:p3", paneToken: null },
      { paneId: "w1:p4", paneToken: "a1b2" }
    ]);
  });

  it("resolves a stable pane name from the pane label or managed tab label", async () => {
    const native = { async request() { return { snapshot: {
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: " pane-name " },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
        { pane_id: "w1:p3", tab_id: "w1:t3", workspace_id: "w1" }
      ],
      agents: [],
      tabs: [
        { tab_id: "w1:t1", label: "lark_ignored" },
        { tab_id: "w1:t2", label: "lark_nxmz" },
        { tab_id: "w1:t3", label: "shell" }
      ]
    } }; } };
    const runner: CommandRunner = { async run() { throw new Error("CLI must not be used"); } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).listAllPanes()).resolves.toMatchObject([
      { paneId: "w1:p1", label: " pane-name ", paneName: "pane-name" },
      { paneId: "w1:p2", label: null, paneName: "nxmz" },
      { paneId: "w1:p3", label: null, paneName: null }
    ]);
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

  it("reads the live Workspace directory without deriving identity from configured projects", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return json({ workspaces: [{ workspace_id: "w1", label: "Alpha" }, { workspace_id: "w4", label: "herdr" }] });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).listWorkspaces()).resolves.toEqual([
      { workspaceId: "w1", label: "Alpha" }, { workspaceId: "w4", label: "herdr" }
    ]);
    expect(calls).toEqual([["workspace", "list"]]);
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

  it("launches an Orchestrator TraeX session under the Core rotation supervisor", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "idle" }], agents: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "/opt/herdr/bin/herdr", 1000).startAgent("w1:p1", {
      name: "project-orchestrator", kind: "traex", executable: "/opt/traex", args: ["--model", "x"], rotatable: true
    });

    expect(calls[0]).toEqual(["agent", "start", "project-orchestrator", "--kind", "traex", "--pane", "w1:p1", "--timeout", "1000", "--rotatable", "--", "--permission-mode", "auto", "--model", "x"]);
  });

  it("probes and invokes the exact tab.create.v2 identity contract", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args.at(-1) === "--help") {
        return { stdout: "herdr tab create --expected-workspace-label TEXT --token TOKEN", stderr: "" };
      }
      return json({
        type: "tab_created",
        tab: { tab_id: "w4:t7", workspace_id: "w4", label: "orchestrator" },
        root_pane: {
          pane_id: "w4:p9", terminal_id: "term-orch", token: "orch",
          tab_id: "w4:t7", workspace_id: "w4", cwd: "/repo", label: "orchestrator"
        }
      });
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.createPaneV2?.({
      workspaceId: "w4",
      expectedWorkspaceLabel: "herdr",
      token: "orch",
      cwd: "/repo",
      options: {
        bindingId: "binding-1", generation: 3, projectId: "repo",
        placement: "dedicated-tab", title: "orchestrator",
        displayIdentity: { role: { kind: "managed-primary" } },
        environment: { HERDR_AGENT_ROLE: "orchestrator" }
      }
    })).resolves.toEqual({ outcome: "created", receipt: {
      workspaceId: "w4", tabId: "w4:t7", paneId: "w4:p9",
      terminalId: "term-orch", token: "orch"
    } });
    expect(calls).toEqual([
      ["tab", "create", "--help"],
      [
        "tab", "create", "--workspace", "w4", "--expected-workspace-label", "herdr",
        "--token", "orch", "--cwd", "/repo", "--label", "lark_orchestrator",
        "--env", "HERDR_BRIDGE_BINDING_ID=binding-1", "--env", "HERDR_BRIDGE_GENERATION=3",
        "--env", "HERDR_PROJECT_ID=repo", "--env", "HERDR_AGENT_ROLE=orchestrator", "--no-focus"
      ],
      ["pane", "rename", "w4:p9", "orch-main"],
      ["tab", "rename", "w4:t7", "orch"]
    ]);
  });

  it("normalizes missing tab.create.v2 capability without invoking creation", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return { stdout: "herdr tab create --workspace ID --cwd PATH", stderr: "" };
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.createPaneV2?.({
      workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/repo",
      options: { bindingId: "binding-1", generation: 3, projectId: "repo", placement: "dedicated-tab" }
    })).resolves.toEqual({
      outcome: "capability-unavailable", capability: "tab.create.v2",
      reason: "Herdr Core does not advertise tab.create.v2"
    });
    expect(calls).toEqual([["tab", "create", "--help"]]);
  });

  it("normalizes an exact native token collision", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") return { stdout: "--expected-workspace-label --token", stderr: "" };
      throw new CommandError("herdr", args, JSON.stringify({
        id: "cli:tab:create:v2",
        error: { code: "pane_token_conflict", message: "pane token orch is already in use" }
      }), false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPaneV2({
      workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/repo",
      options: { bindingId: "binding-1", generation: 3, projectId: "repo", placement: "dedicated-tab" }
    })).resolves.toEqual({
      outcome: "token-conflict", code: "pane_token_conflict",
      reason: "pane token orch is already in use"
    });
  });

  it("probes and invokes the exact pane.identity_reconcile.v1 contract", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      return json({ receipt: {
        operation_id: "migration-1", disposition: "applied",
        previous: { pane_id: "w1:p2", terminal_id: "term-1", workspace_id: "w1", token: "old1" },
        current: { pane_id: "w4:p7", terminal_id: "term-1", workspace_id: "w4", token: "orch" }
      } });
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.reconcilePaneIdentityV1?.({
      operationId: "migration-1",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({ outcome: "applied", receipt: {
      operationId: "migration-1", disposition: "applied",
      previous: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      current: { paneId: "w4:p7", terminalId: "term-1", workspaceId: "w4", token: "orch" }
    } });
    expect(calls).toEqual([
      ["pane", "identity-reconcile", "--help"],
      [
        "pane", "identity-reconcile", "--operation-id", "migration-1",
        "--expected-pane", "w1:p2", "--expected-terminal", "term-1",
        "--expected-workspace", "w1", "--expected-token", "old1",
        "--target-workspace", "w4", "--expected-workspace-label", "herdr",
        "--token", "orch"
      ]
    ]);
  });

  it("does not accept a partial pane identity reconciliation capability", async () => {
    const runner: CommandRunner = { async run() {
      return { stdout: "--operation-id --expected-terminal --expected-workspace-label --token", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).supportsPaneIdentityReconcileV1())
      .resolves.toBe(false);
  });

  it("normalizes missing pane.identity_reconcile.v1 without invoking mutation", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return { stdout: "herdr pane move", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-unavailable",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "capability-unavailable", capability: "pane.identity_reconcile.v1",
      reason: "Herdr Core does not advertise pane.identity_reconcile.v1"
    });
    expect(calls).toEqual([["pane", "identity-reconcile", "--help"]]);
  });

  it("normalizes a target Space label race during identity reconciliation", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      throw new CommandError("herdr", args, JSON.stringify({
        error: { code: "workspace_label_mismatch", message: "target workspace label no longer matches" }
      }), false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-label-race",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "label-mismatch", code: "workspace_label_mismatch",
      reason: "target workspace label no longer matches"
    });
  });

  it("normalizes a stale source identity fence", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      throw new CommandError("herdr", args, JSON.stringify({
        error: { code: "stale_source_identity", message: "source pane identity no longer matches" }
      }), false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-stale",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "stale-fence", code: "stale_source_identity",
      reason: "source pane identity no longer matches"
    });
  });

  it("preserves an authoritative Core rejection as a stable adapter result", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      throw new CommandError("herdr", args, JSON.stringify({
        error: { code: "pane_identity_busy", message: "source pane cannot migrate while its tab is zoomed" }
      }), false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-busy",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "rejected", code: "pane_identity_busy",
      reason: "source pane cannot migrate while its tab is zoomed"
    });
  });

  it("classifies a versioned Core command timeout as uncertain", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") return { stdout: "--expected-workspace-label --token", stderr: "" };
      throw new CommandError("herdr", args, "operation timed out", true);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPaneV2({
      workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/repo",
      options: { bindingId: "binding-1", generation: 3, projectId: "repo", placement: "dedicated-tab" }
    })).resolves.toEqual({
      outcome: "uncertain", code: "transport_timeout",
      reason: "Herdr tab.create.v2 timed out; the external effect is uncertain"
    });
  });

  it("preserves Core's authoritative identity uncertainty", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      throw new CommandError("herdr", args, JSON.stringify({
        error: {
          code: "pane_identity_reconcile_uncertain",
          message: "identity changed but receipt could not be persisted"
        }
      }), false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-uncertain",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "uncertain", code: "pane_identity_reconcile_uncertain",
      reason: "identity changed but receipt could not be persisted"
    });
  });

  it("classifies an unstructured post-launch transport failure as uncertain", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") {
        return { stdout: IDENTITY_RECONCILE_HELP, stderr: "" };
      }
      throw new CommandError("herdr", args, "socket closed before a receipt arrived", false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).reconcilePaneIdentityV1({
      operationId: "migration-transport",
      expected: { paneId: "w1:p2", terminalId: "term-1", workspaceId: "w1", token: "old1" },
      target: { workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch" }
    })).resolves.toEqual({
      outcome: "uncertain", code: "transport_failure",
      reason: "Herdr pane.identity_reconcile.v1 failed without an authoritative receipt; the external effect is uncertain"
    });
  });

  it("normalizes malformed versioned Core JSON separately from transport uncertainty", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") return { stdout: "--expected-workspace-label --token", stderr: "" };
      return { stdout: "{not-json", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPaneV2({
      workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/repo",
      options: { bindingId: "binding-1", generation: 3, projectId: "repo", placement: "dedicated-tab" }
    })).resolves.toEqual({
      outcome: "malformed-response", code: "malformed_json",
      reason: "Herdr tab.create.v2 returned malformed JSON"
    });
  });

  it("rejects a structurally invalid Core identity receipt as malformed", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") return { stdout: "--expected-workspace-label --token", stderr: "" };
      return json({ type: "tab_created", tab: { tab_id: "w4:t7", workspace_id: "w4" }, root_pane: {
        pane_id: "w4:p9", terminal_id: null, token: "orch", tab_id: "w4:t7", workspace_id: "w4"
      } });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPaneV2({
      workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/repo",
      options: { bindingId: "binding-1", generation: 3, projectId: "repo", placement: "dedicated-tab" }
    })).resolves.toEqual({
      outcome: "malformed-response", code: "invalid_response",
      reason: "Herdr tab.create.v2 returned an invalid response"
    });
  });

  it("feature-detects and invokes exact same-Pane session rotation", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args.at(-1) === "--help") return { stdout: "herdr agent session-rotate --operation-id ID --expected-state-change-seq SEQ", stderr: "" };
      return json({ rotation: { outcome: "rotated", receipt: {
        operation_id: "clear-1", pane_id: "w1:p1", terminal_id: "terminal-1",
        old_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
        new_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-2" }
      } } });
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.supportsSessionRotation?.()).resolves.toBe(true);
    await expect(adapter.rotateSession?.({
      operationId: "clear-1", paneId: "w1:p1", expectedTerminalId: "terminal-1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      expectedStateChangeSeq: 17,
      launch: { name: "project-orchestrator", kind: "traex", args: ["--model", "x"] }
    })).resolves.toEqual({ outcome: "rotated", receipt: {
      operationId: "clear-1", paneId: "w1:p1", terminalId: "terminal-1",
      oldSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      newSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-2" }
    } });
    expect(calls[1]).toEqual([
      "agent", "session-rotate", "--operation-id", "clear-1", "--pane", "w1:p1",
      "--expected-terminal-id", "terminal-1", "--expected-session-source", "herdr:traex",
      "--expected-session-agent", "traex", "--expected-session-kind", "id",
      "--expected-session-value", "session-1", "--expected-state-change-seq", "17",
      "--name", "project-orchestrator", "--kind", "traex", "--timeout", "1000", "--", "--model", "x"
    ]);
  });

  it("normalizes a Session Rotation timeout without exposing launch arguments", async () => {
    const secret = "secret-launch-argument";
    const runner: CommandRunner = { async run(_executable, args) {
      if (args.at(-1) === "--help") return { stdout: "--operation-id --expected-state-change-seq", stderr: "" };
      throw new CommandError("herdr", args, `rotation timed out while launching ${secret}`, true);
    } };
    const result = await new HerdrCliAdapter(runner, "herdr", 1000).rotateSession({
      operationId: "clear-timeout", paneId: "w1:p1", expectedTerminalId: "terminal-1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      expectedStateChangeSeq: 17,
      launch: { name: "project-orchestrator", kind: "traex", args: ["--resume-token", secret] }
    });

    expect(result).toEqual({
      outcome: "uncertain", operationId: "clear-timeout", paneId: "w1:p1",
      reason: "Herdr agent.session_rotate.v1 timed out; the external effect is uncertain"
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("normalizes an unstructured Session Rotation transport failure as uncertain", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      throw new CommandError("herdr", args, "socket closed before a receipt arrived", false);
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).rotateSession({
      operationId: "clear-transport", paneId: "w1:p1", expectedTerminalId: "terminal-1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      expectedStateChangeSeq: 17,
      launch: { name: "project-orchestrator", kind: "traex" }
    })).resolves.toEqual({
      outcome: "uncertain", operationId: "clear-transport", paneId: "w1:p1",
      reason: "Herdr agent.session_rotate.v1 failed without an authoritative receipt; the external effect is uncertain"
    });
  });

  it("normalizes malformed Session Rotation JSON distinctly", async () => {
    const runner: CommandRunner = { async run() { return { stdout: "not-json", stderr: "" }; } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).rotateSession({
      operationId: "clear-malformed", paneId: "w1:p1", expectedTerminalId: "terminal-1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      expectedStateChangeSeq: 17,
      launch: { name: "project-orchestrator", kind: "traex" }
    })).resolves.toEqual({
      outcome: "malformed-response", operationId: "clear-malformed", paneId: "w1:p1",
      reason: "Herdr agent.session_rotate.v1 returned malformed JSON"
    });
  });

  it("fails closed when Core does not advertise session rotation", async () => {
    const runner: CommandRunner = { async run() { return { stdout: "herdr agent start", stderr: "" }; } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.supportsSessionRotation?.()).resolves.toBe(false);
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

  it("distinguishes an observed empty process list from an unavailable process probe", async () => {
    const emptyRunner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } });
      if (args[0] === "pane") return json({ process_info: { foreground_processes: [] } });
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    } };
    await expect(new HerdrCliAdapter(emptyRunner, "herdr", 1000).observeRuntime("w1:p1")).resolves.toMatchObject({
      processProbe: "observed", traexProcess: false, pane: { foregroundExecutables: [] }
    });

    const unavailableRunner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "api") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } });
      throw new Error("process info unavailable");
    } };
    await expect(new HerdrCliAdapter(unavailableRunner, "herdr", 1000).observeRuntime("w1:p1")).resolves.toMatchObject({
      processProbe: "unavailable", traexProcess: false, pane: { foregroundExecutables: [] }
    });
  });

  it("falls back from native process probing to the CLI and refuses startup when both probes fail", async () => {
    const native = { async request(method: string) {
      if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: [] } };
      if (method === "pane.process_info") throw new Error("native unavailable");
      throw new Error(`unexpected method: ${method}`);
    } };
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).observeRuntime("w1:p1")).resolves.toMatchObject({
      processProbe: "observed", traexProcess: true, pane: { foregroundExecutables: ["traex"] }
    });

    const failingCalls: string[][] = [];
    const failingRunner: CommandRunner = { async run(_executable, args) { failingCalls.push(args); throw new Error("CLI unavailable"); } };
    await expect(new HerdrCliAdapter(failingRunner, "herdr", 1000, "auto", native).startTraex("w1:p1", "/opt/traex"))
      .rejects.toThrow("process probe is unavailable");
    expect(failingCalls.some((args) => args[0] === "agent" && args[1] === "start")).toBe(false);
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

  it("revalidates ctrl+c through durable events when agent get omits active_turn_id", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get") return json({ agent: {
        pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "working",
        agent_session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      } });
      if (args[0] === "agent" && args[1] === "events" && args[2] === "turns") return json({ turns: [
        { turn_id: "turn-old", started_at: "2026-10-12T11:00:00.000Z", terminal_state: "completed" },
        { turn_id: "turn-1", started_at: "2026-10-12T11:01:00.000Z" }
      ] });
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).interruptAgent({
      paneId: "w1:p1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      runtimeTurnId: "turn-1", idempotencyKey: "control-1"
    })).resolves.toEqual({ status: "interrupted" });
    expect(calls).toEqual([
      ["agent", "get", "w1:p1"],
      ["agent", "events", "turns", "--kind", "traex", "--session-id", "session-1", "--limit", "128"],
      ["agent", "send-keys", "w1:p1", "ctrl+c"]
    ]);
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

  it("uses the direct workspace query when global snapshot fallback is already decided", async () => {
    const native = { request: vi.fn(async () => { throw new Error("global snapshot must be skipped"); }) };
    const runner: CommandRunner = { async run(_executable, args) {
      expect(args).toEqual(["pane", "list", "--workspace", "w1"]);
      return json({ panes: [] });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000, "auto", native).listPanes("w1", { skipAllWorkspaceSnapshot: true })).resolves.toEqual([]);

    expect(native.request).not.toHaveBeenCalled();
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

  it("queues an ordinary prompt with a submission receipt and exact native session fence", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      expect(args).toEqual([
        "agent", "prompt", "w1:p1", "continue",
        "--submission-id", "prompt-1",
        "--expected-session-id", "session-1",
        "--wait", "--until", "working", "--until", "blocked", "--timeout", "1000"
      ]);
      return { stdout: JSON.stringify({ result: {
        type: "agent_prompted", agent: { agent_status: "working" }, submission_id: "prompt-1",
        submission_receipt: {
          submission_id: "prompt-1", terminal_id: "terminal-1", agent_kind: "traex",
          session_id: "session-1", state: "accepted", created_at: 10, updated_at: 11
        }
      } }), stderr: "" };
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.queuePrompt?.("w1:p1", "continue", {
      submissionId: "prompt-1",
      expectedSessionId: "session-1"
    })).resolves.toEqual({
      submissionId: "prompt-1",
      receipt: {
        submissionId: "prompt-1", terminalId: "terminal-1", agentKind: "traex",
        sessionId: "session-1", state: "accepted", createdAt: 10, updatedAt: 11
      }
    });
  });

  it("queues a model-aware prompt through the distinct fail-closed Core method", async () => {
    const runner: CommandRunner = { async run(_executable, args) {
      expect(args).toEqual([
        "agent", "prompt", "w1:p1", "continue",
        "--submission-id", "prompt-1",
        "--expected-session-id", "session-1",
        "--model", "gpt-5.4",
        "--wait", "--until", "working", "--until", "blocked", "--timeout", "1000"
      ]);
      return { stdout: JSON.stringify({ result: { type: "agent_prompted", agent: { agent_status: "working" }, submission_id: "prompt-1" } }), stderr: "" };
    } };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.queueModelPrompt?.("w1:p1", "continue", {
      model: "gpt-5.4",
      submissionId: "prompt-1",
      expectedSessionId: "session-1"
    })).resolves.toEqual({ submissionId: "prompt-1" });
  });

  it("feature-detects the distinct model prompt contract independently", async () => {
    const run = vi.fn(async () => ({
      stdout: "Usage: herdr agent prompt <PANE> <TEXT> --submission-id <ID> --expected-session-id <SESSION> --model <MODEL>",
      stderr: ""
    }));
    const adapter = new HerdrCliAdapter({ run } as never, "herdr", 1000);

    await expect(adapter.supportsModelPrompt?.()).resolves.toBe(true);
    await expect(adapter.supportsModelPrompt?.()).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("feature-detects and caches the native prompt queue contract", async () => {
    const run = vi.fn(async (_executable, args: string[]) => {
      expect(args).toEqual(["agent", "prompt", "--help"]);
      return { stdout: "Usage: herdr agent prompt <PANE> <TEXT> --submission-id <ID> --expected-session-id <SESSION>", stderr: "" };
    });
    const adapter = new HerdrCliAdapter({ run } as never, "herdr", 1000);

    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(true);
    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps the legacy wait-until-idle path when Core lacks the native prompt queue contract", async () => {
    const run = vi.fn(async () => ({ stdout: "Usage: herdr agent prompt <PANE> <TEXT> --wait", stderr: "" }));
    const adapter = new HerdrCliAdapter({ run } as never, "herdr", 1000);

    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(false);
  });

  it("rechecks native prompt queue support after an earlier negative capability probe", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "Usage: herdr agent prompt <PANE> <TEXT> --wait", stderr: "" })
      .mockResolvedValue({ stdout: "Usage: herdr agent prompt <PANE> <TEXT> --submission-id <ID> --expected-session-id <SESSION>", stderr: "" });
    const adapter = new HerdrCliAdapter({ run } as never, "herdr", 1000);

    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(false);
    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(true);
    await expect(adapter.supportsPromptQueue?.()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
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
      expect(store.getPrompt("p1")).toMatchObject({ state: "submitted", observationState: "not_started", dispatchedAt: null });
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

  it("renames a new managed Primary from its authoritative token and labels its tab with the Group Token", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "tab" && args[1] === "create") return json({ root_pane: {
        pane_id: "w1:p2", token: "9E2U", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo"
      } });
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };

    const pane = await new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", {
      bindingId: "b1", generation: 1, projectId: "repo", placement: "dedicated-tab",
      title: "provisional", displayIdentity: { role: { kind: "managed-primary" } }
    });

    expect(pane).toMatchObject({ paneId: "w1:p2", paneToken: "9e2u", tabId: "w1:t2" });
    expect(calls).toContainEqual(["pane", "rename", "w1:p2", "9e2u-main"]);
    expect(calls).toContainEqual(["tab", "rename", "w1:t2", "9e2u"]);
  });

  it("splits the exact parent pane and applies one Worker identity in the existing tab", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "split") return json({ pane: {
        pane_id: "w1:p3", token: "wk42", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo/worker"
      } });
      if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
      return { stdout: "", stderr: "" };
    } };

    await new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo/worker", {
      bindingId: "worker", generation: 2, projectId: "repo", placement: "split", anchorPaneId: "w1:p2",
      displayIdentity: { groupToken: "9e2u", role: { kind: "worker", name: "reviewer" } }
    });

    expect(calls[0]).toEqual([
      "pane", "split", "--pane", "w1:p2", "--direction", "down", "--ratio", "0.5", "--cwd", "/repo/worker",
      "--env", "HERDR_BRIDGE_BINDING_ID=worker", "--env", "HERDR_BRIDGE_GENERATION=2", "--env", "HERDR_PROJECT_ID=repo", "--no-focus"
    ]);
    expect(calls).toContainEqual(["pane", "rename", "w1:p3", "9e2u-reviewer"]);
    expect(calls).toContainEqual(["tab", "rename", "w1:t2", "9e2u"]);
  });

  it("moves one pane to an exact target and normalizes a changed Pane ID receipt", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return json({ move_result: {
        previous_pane_id: "w1:p2",
        pane: { pane_id: "w1:p3", token: "wk42", tab_id: "w1:t1", workspace_id: "w1", cwd: "/repo/worker" }
      } });
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).movePane?.({
      paneId: "w1:p2", targetTabId: "w1:t1", targetAnchorPaneId: "w1:p1",
      paneLabel: "9e2u-reviewer", tabLabel: "9e2u"
    })).resolves.toEqual({ previousPaneId: "w1:p2", paneId: "w1:p3", paneToken: "wk42", tabId: "w1:t1", workspaceId: "w1" });
    expect(calls).toEqual([[
      "pane", "move", "w1:p2", "--tab", "w1:t1", "--target-pane", "w1:p1", "--split", "down", "--ratio", "0.5",
      "--label", "9e2u-reviewer", "--tab-label", "9e2u", "--no-focus"
    ]]);
  });

  it("labels one exact pane and its owning tab without changing runtime identity", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return { stdout: "", stderr: "" };
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).labelPane?.({
      workspaceId: "w1", paneId: "w1:p2", paneToken: "wk42", tabId: "w1:t1",
      paneLabel: "9e2u-reviewer", tabLabel: "9e2u"
    })).resolves.toEqual({
      previousPaneId: "w1:p2", paneId: "w1:p2", paneToken: "wk42", tabId: "w1:t1", workspaceId: "w1"
    });
    expect(calls).toEqual([
      ["pane", "rename", "w1:p2", "9e2u-reviewer"],
      ["tab", "rename", "w1:t1", "9e2u"]
    ]);
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

  it("normalizes structured invalid_cursor session stream and ring failures without masking unrelated errors", async () => {
    const invalidCursor = Object.assign(new Error("stale cursor"), { code: "invalid_cursor" });
    const unrelated = Object.assign(new Error("Core unavailable"), { code: "unavailable" });
    const request = vi.fn(async (method: string) => {
      if (method === "session.events.read") throw invalidCursor;
      if (method === "session.events.read.v2") throw invalidCursor;
      if (method === "session.events.subscribe") throw unrelated;
      throw new Error(`unexpected method: ${method}`);
    });
    const adapter = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", { request });

    await expect(adapter.readSession("stream-1", "cursor-1")).resolves.toEqual({ outcome: "invalid_cursor" });
    await expect(adapter.readSessionRing("ring-1", "cursor-1")).resolves.toEqual({ outcome: "invalid_cursor" });
    await expect(adapter.subscribeSession("stream-1", "cursor-1")).rejects.toBe(unrelated);
  });
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
