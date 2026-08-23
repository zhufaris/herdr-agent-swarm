import { describe, expect, it } from "vitest";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

describe("Herdr adapter", () => {
  it("uses one Herdr snapshot command for all panes in a workspace", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      return json({ snapshot: {
        panes: [
          { pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo", agent: "traex", agent_status: "working", terminal_id: "term-1" },
          { pane_id: "w2:p1", workspace_id: "w2", cwd: "/other", agent_status: "idle" }
        ],
        agents: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "blocked", state_change_seq: 42 }]
      } });
    } };
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).listPanes("w1")).resolves.toEqual([{
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: null, agentKind: "traex", stateChangeSeq: 42, agentState: "blocked", foregroundExecutables: ["traex"]
    }]);
    expect(calls).toEqual([["api", "snapshot"]]);
  });

  it("falls back to pane process inspection when snapshot is incompatible", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "api") return json({ incompatible: true });
      if (args[1] === "list") return json({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo", agent_status: "idle" }] });
      return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
    } };
    const panes = await new HerdrCliAdapter(runner, "herdr", 1000).listPanes("w1");
    expect(panes[0]?.foregroundExecutables).toEqual(["traex"]);
    expect(calls).toEqual([["api", "snapshot"], ["pane", "list", "--workspace", "w1"], ["pane", "process-info", "--pane", "w1:p1"]]);
  });

  it("creates a dedicated unfocused Lark tab and returns its root pane", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args, _timeout, onStarted) {
        calls.push(args);
        await onStarted?.();
        if (args[0] === "tab" && args[1] === "create") return json({
          tab: { tab_id: "w1:t7", workspace_id: "w1", label: "lark_space / Task" },
          root_pane: { pane_id: "w1:p7", workspace_id: "w1", cwd: "/repo", terminal_id: "term-7" }
        });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", {
      bindingId: "binding-7", generation: 2, projectId: "project-7", title: "space / Task", placement: "dedicated-tab"
    })).resolves.toMatchObject({ paneId: "w1:p7", workspaceId: "w1", cwd: "/repo", terminalId: "term-7" });
    expect(calls[0]).toEqual([
      "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "lark_space / Task",
      "--env", "HERDR_BRIDGE_BINDING_ID=binding-7", "--env", "HERDR_BRIDGE_GENERATION=2",
      "--env", "HERDR_PROJECT_ID=project-7", "--no-focus"
    ]);
  });

  it("renames a managed pane and its containing Lark tab", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p7", workspace_id: "w1", tab_id: "w1:t7" } });
        return { stdout: "", stderr: "" };
      }
    };

    await new HerdrCliAdapter(runner, "herdr", 1000).renamePane("w1:p7", "Better pane", { tabTitle: "lark_Better pane" });
    expect(calls).toEqual([
      ["pane", "rename", "w1:p7", "Better pane"],
      ["pane", "get", "w1:p7"],
      ["tab", "rename", "w1:t7", "lark_Better pane"]
    ]);
  });

  it("reads terminal output from the pane without requiring an agent registration", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "read") throw new Error("agent_not_found");
        if (args[0] === "pane" && args[1] === "read") return { stdout: "TraeX ready", stderr: "" };
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).readOutput("wA:p3", 240))
      .resolves.toBe("TraeX ready");
    expect(calls).toEqual([["pane", "read", "wA:p3", "--source", "recent-unwrapped", "--lines", "240", "--format", "text"]]);
  });

  it("identifies TraeX from process metadata, not the compatibility label", async () => {
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[1] === "list") return json({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo", agent_status: "idle", agent: "codex" }] });
        if (args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex", argv: ["/usr/bin/traex"] }] } });
        throw new Error(`unexpected args: ${args.join(" " )}`);
      }
    };
    const panes = await new HerdrCliAdapter(runner, "herdr", 1000).listPanes("w1");
    expect(panes[0]?.foregroundExecutables).toContain("traex");
  });

  it("does not restart TraeX when snapshot is unknown but the pane process is already ready", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "api" && args[1] === "snapshot") {
          return json({ snapshot: {
            panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }],
            agents: []
          } });
        }
        if (args[0] === "pane" && args[1] === "process-info") {
          return json({ process_info: { foreground_processes: [{ name: "traex", argv: ["/home/user/.local/bin/traex"] }] } });
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).startTraex("w1:p1", "traex"))
      .resolves.toBeUndefined();
    expect(calls).toEqual([
      ["api", "snapshot"],
      ["pane", "process-info", "--pane", "w1:p1"]
    ]);
  });

  it("detects TraeX through process inspection after starting an unknown snapshot pane", async () => {
    const calls: string[][] = [];
    let started = false;
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "api" && args[1] === "snapshot") {
          return json({ snapshot: {
            panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }],
            agents: []
          } });
        }
        if (args[0] === "pane" && args[1] === "process-info") {
          return json({ process_info: { foreground_processes: started ? [{ name: "traex" }] : [] } });
        }
        if (args[0] === "pane" && args[1] === "run") {
          started = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).startTraex("w1:p1", "/usr/local/bin/traex"))
      .resolves.toBeUndefined();
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "run")).toEqual([
      ["pane", "run", "w1:p1", "/usr/local/bin/traex", "--permission-mode", "auto"]
    ]);
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "process-info")).toHaveLength(2);
  });

  it("closes a pane and verifies that it disappeared", async () => {
    const calls: string[][] = [];
    let exists = true;
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "close") {
          exists = false;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "api" && args[1] === "snapshot") {
          return json({ snapshot: {
            panes: exists ? [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" }] : [],
            agents: []
          } });
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).closePane("w1:p1"))
      .resolves.toBeUndefined();
    expect(calls).toEqual([["pane", "close", "w1:p1"], ["api", "snapshot"]]);
  });

  it("treats a close command error as success when the pane nevertheless disappeared", async () => {
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "close") throw new Error("connection closed");
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: { panes: [], agents: [] } });
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).closePane("w1:p1"))
      .resolves.toBeUndefined();
  });

  it("injects a prompt into TraeX and waits for its terminal turn to finish", async () => {
    const calls: string[][] = [];
    const outputs = ["before", "before\n❯ hello", "✧ Working", "answer", "answer", "answer"];
    const runner: CommandRunner = {
      async run(_executable, args, _timeout, onStarted) {
        calls.push(args);
        await onStarted?.();
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "answer", stderr: "" };
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: outputs.length > 2 ? "working" : "done" }], agents: [] } });
        return { stdout: "", stderr: "" };
      }
    };

    let dispatched = false;
    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 1000, undefined, undefined, () => { dispatched = true; })).resolves.toBe("done");
    expect(dispatched).toBe(true);
    expect(calls).toContainEqual(["agent", "prompt", "w1:p1", "hello"]);
    expect(calls.some((args) => args[1] === "send-text" || args[1] === "send-keys")).toBe(false);
  });

  it("falls back to pane input when Herdr rejects a detected TraeX pane as an unnamed agent", async () => {
    const calls: string[][] = [];
    const outputs = ["before", "before", "before\n❯ continue", "✧ Working", "answer", "answer"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "prompt") {
          throw new Error('{"error":{"code":"agent_not_ready","message":"agent w1:p1 is not an active named agent"}}');
        }
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "answer", stderr: "" };
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: outputs.length > 2 ? "working" : "done" }], agents: [] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "continue", 1000)).resolves.toBe("done");
    expect(calls).toContainEqual(["agent", "prompt", "w1:p1", "continue"]);
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "continue"]);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);
  });

  it("does not retry through pane input after an ambiguous native prompt failure", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_executable, args) {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "read") return { stdout: "before", stderr: "" };
      throw new Error("connection lost after prompt submission");
    } };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "continue", 1000))
      .rejects.toThrow(/connection lost/);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "send-text")).toBe(false);
  });

  it("runs a pane slash command and returns only its stable native output", async () => {
    const calls: string[][] = [];
    const outputs = [
      "TraeX ready\n❯",
      "TraeX ready\n❯ /model GPT-5.5",
      "TraeX ready\n❯ /model GPT-5.5\n\u001b[32mCurrent model: GPT-5.5\u001b[0m\ntoken=secret-value",
      "TraeX ready\n❯ /model GPT-5.5\n\u001b[32mCurrent model: GPT-5.5\u001b[0m\ntoken=secret-value"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? outputs.at(-1) ?? "", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPaneCommand("w1:p1", "/model GPT-5.5", 1000))
      .resolves.toBe("Current model: GPT-5.5\ntoken=[REDACTED]");
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "/model GPT-5.5"]);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);
  });

  it("keeps the turn open while approval is blocked and completes after approval", async () => {
    const states = ["working", "blocked", "blocked", "working", "done"] as const;
    const outputs = ["before", "before\n❯ needs approval"];
    const observed: Array<{ state: string; output: string }> = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "terminal", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") {
          const agent_status = states.shift() ?? "done";
          return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status } });
        }
        if (args[0] === "pane" && args[1] === "process-info") {
          return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        }
        return { stdout: "", stderr: "" };
      }
    };

    const turn = new HerdrCliAdapter(runner, "herdr", 1000).runPrompt(
      "w1:p1", "needs approval", 2000, (observation) => { observed.push(observation); }
    );

    await expect(turn).resolves.toBe("done");
    expect(observed.map(({ state }) => state)).toEqual(["working", "blocked", "working", "done"]);
    expect(observed.at(-1)?.output).toBe("terminal");
  });

  it("fails promptly when the pane disappears during a turn", async () => {
    let paneReads = 0;
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: paneReads++ === 0 ? "before" : "before\n❯ hello", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") throw new Error("pane not found");
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 60_000))
      .rejects.toThrow("Herdr pane not found: w1:p1");
  });

  it("cancels prompt polling without waiting for the turn timeout", async () => {
    const controller = new AbortController();
    const outputs = ["before", "before\n❯ hello"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "working", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };
    const turn = new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 60_000, undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(turn).rejects.toThrow("Bridge shutdown detached from an in-flight TraeX turn");
  });

  it("steers only while structured pane state is working", async () => {
    const calls: string[][] = [];
    let state: "working" | "blocked" = "working";
    const outputs = ["before", "before\n❯ change course"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "before\n❯ change course", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: state } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.steerPrompt("w1:p1", "change course")).resolves.toBe("injected");
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "change course"]);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);

    state = "blocked";
    calls.length = 0;
    await expect(adapter.steerPrompt("w1:p1", "do not inject")).resolves.toBe("not_working");
    expect(calls.some((args) => args[1] === "send-text" || args[1] === "send-keys")).toBe(false);
  });

  it("surfaces an uncertain steering delivery when Enter fails after text was sent", async () => {
    const calls: string[][] = [];
    const outputs = ["before", "before\n❯ possibly typed"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "before\n❯ possibly typed", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        if (args[0] === "pane" && args[1] === "send-keys") throw new Error("enter failed");
        return { stdout: "", stderr: "" };
      }
    };
    const adapter = new HerdrCliAdapter(runner, "herdr", 1000);

    await expect(adapter.steerPrompt("w1:p1", "possibly typed")).rejects.toThrow("enter failed");
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "possibly typed"]);
  });

  it("does not treat an earlier matching prompt as confirmation of new text", async () => {
    const calls: string[][] = [];
    const outputs = ["◆ hi\n❯", "◆ hi\n❯", "◆ hi\n❯ hi"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "◆ hi\n❯ hi", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).steerPrompt("w1:p1", "hi")).resolves.toBe("injected");
    const enterIndex = calls.findIndex((args) => args[0] === "pane" && args[1] === "send-keys");
    const readsBeforeEnter = calls.slice(0, enterIndex).filter((args) => args[0] === "pane" && args[1] === "read");
    expect(readsBeforeEnter).toHaveLength(3);
  });

  it("confirms prompt text when a narrow pane soft-wraps it", async () => {
    const calls: string[][] = [];
    const outputs = [
      "❯ Explain this codebase",
      "▍ 你好，请回复当前工作目\n▍ 录"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "◆ 当前工作目录：/repo", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).steerPrompt("w1:p1", "你好，请回复当前工作目录"))
      .resolves.toBe("injected");
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);
  });

  it("does not send Enter when the composer never confirms the prompt text", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: "unchanged terminal", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 40).steerPrompt("w1:p1", "lost prompt"))
      .rejects.toThrow("Timed out waiting for prompt text in pane w1:p1");
    expect(calls.some((args) => args[0] === "pane" && args[1] === "send-keys")).toBe(false);
  });
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
