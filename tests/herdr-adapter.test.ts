import { describe, expect, it } from "vitest";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

describe("Herdr adapter", () => {
  it("recovers an unknown bound pane from exact TraeX process and composer evidence", async () => {
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: {
          panes: [{ pane_id: "w1:p1", workspace_id: "w1", terminal_id: "term-1", agent_status: "unknown" }], agents: []
        } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: {
          foreground_processes: [{ name: "traex", argv: ["/home/user/.local/bin/traex", "--permission-mode", "auto"] }]
        } });
        if (args[0] === "pane" && args[1] === "read") return { stdout: "◆ complete\n────────\n❯ Use /skills to list available skills", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).observeRuntime("w1:p1")).resolves.toMatchObject({
      pane: { paneId: "w1:p1", terminalId: "term-1", agentState: "idle", foregroundExecutables: ["traex"] },
      traexProcess: true, composerReady: true, evidenceSource: "recent"
    });
  });

  it("keeps unknown bound panes fail-closed without exact TraeX process evidence", async () => {
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: {
          panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: []
        } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "bash", argv: ["/bin/bash"] }] } });
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).observeRuntime("w1:p1")).resolves.toMatchObject({
      pane: { agentState: "unknown", foregroundExecutables: ["bash"] },
      traexProcess: false, composerReady: false, evidenceSource: "process"
    });
  });

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
      paneId: "w1:p1", tabId: null, terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: null, agentKind: "traex", stateChangeSeq: 42, agentState: "blocked", foregroundExecutables: ["traex"]
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

  it("waits for composer evidence without restarting an existing TraeX process", async () => {
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
        if (args[0] === "pane" && args[1] === "read") {
          return { stdout: "❯ Use /skills to list available skills", stderr: "" };
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).startTraex("w1:p1", "traex"))
      .resolves.toBeUndefined();
    expect(calls).toEqual([
      ["api", "snapshot"],
      ["pane", "process-info", "--pane", "w1:p1"],
      ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "80", "--format", "text"]
    ]);
  });

  it("times out when an existing TraeX process never renders its composer", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: {
          panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: []
        } });
        if (args[0] === "pane" && args[1] === "process-info") {
          return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        }
        if (args[0] === "pane" && args[1] === "read") return { stdout: "", stderr: "" };
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 20).startTraex("w1:p1", "traex"))
      .rejects.toThrow("TraeX composer did not become ready in pane w1:p1");
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(false);
  });

  it("uses the visible terminal when a new TraeX TUI has no recent scrollback", async () => {
    const sources: string[] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "api" && args[1] === "snapshot") return json({ snapshot: {
          panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], agents: []
        } });
        if (args[0] === "pane" && args[1] === "process-info") {
          return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        }
        if (args[0] === "pane" && args[1] === "read") {
          const source = args[args.indexOf("--source") + 1]!;
          sources.push(source);
          return { stdout: source === "visible" ? "────────\n❯ Write tests for @filename\n────────" : "", stderr: "" };
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).startTraex("w1:p1", "traex"))
      .resolves.toBeUndefined();
    expect(sources).toEqual(["recent-unwrapped", "visible"]);
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
        if (args[0] === "pane" && args[1] === "read") {
          return { stdout: started ? "❯ Use /skills to list available skills" : "", stderr: "" };
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
      ["pane", "run", "w1:p1", "/usr/local/bin/traex", "--permission-mode", "suggest"]
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

  it("completes an unknown-state turn when the composer follows a historical working marker", async () => {
    const terminal = [
      "❯ continue",
      "◆ Working…",
      "The requested work is complete.",
      "❯ Use /skills to list available skills"
    ].join("\n");
    let paneReads = 0;
    const runner: CommandRunner = {
      async run(_executable, args, _timeout, onStarted) {
        await onStarted?.();
        if (args[0] === "pane" && args[1] === "read") {
          return { stdout: paneReads++ === 0 ? "❯" : terminal, stderr: "" };
        }
        if (args[0] === "api" && args[1] === "snapshot") {
          return json({ snapshot: {
            panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "traex", agent_status: "unknown" }],
            agents: []
          } });
        }
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "continue", 1000))
      .resolves.toBe("done");
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

  it("extracts only the current model selector after terminal history rolls over", async () => {
    const calls: string[][] = [];
    const selector = [
      "old answer that must not be replayed",
      "❯ /model",
      "Select Model and Effort",
      " 1. Seed-Evolving          1000K context window",
      " 2. GPT-5.6-Sol (current)  support reasoning",
      "Press enter to confirm or esc to go back"
    ].join("\n");
    const outputs = ["history before command", "different viewport\n❯ /model", selector, selector];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? selector, stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPaneCommand("w1:p1", "/model", 1000))
      .resolves.toBe([
        "Select Model and Effort",
        " 1. Seed-Evolving          1000K context window",
        " 2. GPT-5.6-Sol (current)  support reasoning",
        "Press enter to confirm or esc to go back"
      ].join("\n"));
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Esc"]);
  });

  it("returns a model selector that is visible for only one terminal snapshot", async () => {
    const calls: string[][] = [];
    const selector = [
      "Select Model and Effort",
      " 1. GPT-5.6-Sol (current)  support reasoning",
      " 2. GPT-5.6-Terra           support reasoning",
      "Press enter to confirm or esc to go back"
    ].join("\n");
    const outputs = [
      "answer\n❯", "answer\n❯ /model", selector,
      "answer\n❯ Use /skills to list available skills"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1_000).runPaneCommand("w1:p1", "/model", 1_000)).resolves.toBe(selector);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Esc"]);
  });

  it("selects a model through the native interactive selector instead of prompting the agent", async () => {
    const calls: string[][] = [];
    const outputs = [
      "answer\n❯", "answer\n❯ /model",
      "answer\n❯ /model\nSelect Model and Effort\nType to search models\n1. GPT-5.6-Sol (current)\n2. GPT-5.6-Terra\nPress enter to confirm or esc to go back",
      "answer\nModel switched to GPT-5.6-Terra\n❯ Use /skills to list available skills"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? outputs.at(-1) ?? "", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).selectPaneModel("w1:p1", "GPT-5.6-Terra", 1000))
      .resolves.toBeUndefined();
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "/model"]);
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "GPT-5.6-Terra"]);
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "send-keys" && args[3] === "Enter")).toHaveLength(2);
    expect(calls).not.toContainEqual(["pane", "send-text", "w1:p1", "/model GPT-5.6-Terra"]);
  });

  it("creates default panes with an explicit downward split", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "list") return json({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo", agent_status: "idle" }] });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
        if (args[0] === "pane" && args[1] === "split") return json({ pane: { pane_id: "w1:p2", workspace_id: "w1", cwd: "/repo", agent_status: "idle" } });
        throw new Error("unexpected args: " + args.join(" "));
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo"))
      .resolves.toMatchObject({ paneId: "w1:p2" });
    const split = calls.find((args) => args[0] === "pane" && args[1] === "split");
    expect(split).toContain("--direction");
    expect(split?.[split.indexOf("--direction") + 1]).toBe("down");
    expect(split).not.toContain("right");
  });

  it("creates Lark panes as dedicated tabs without stealing focus", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
        if (args[0] === "tab" && args[1] === "create") return json({
          tab: { tab_id: "w1:t2", workspace_id: "w1" },
          root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo", agent_status: "idle" }
        });
        if (args[0] === "pane" && args[1] === "rename") return { stdout: "", stderr: "" };
        throw new Error("unexpected args: " + args.join(" "));
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).createPane("w1", "/repo", {
      bindingId: "binding-1", generation: 0, projectId: "project-1", placement: "dedicated-tab", title: "Fix login"
    })).resolves.toMatchObject({ paneId: "w1:p2", tabId: "w1:t2" });
    expect(calls[0]).toEqual([
      "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "lark_Fix login",
      "--env", "HERDR_BRIDGE_BINDING_ID=binding-1", "--env", "HERDR_BRIDGE_GENERATION=0",
      "--env", "HERDR_PROJECT_ID=project-1", "--no-focus"
    ]);
    expect(calls).toContainEqual(["pane", "rename", "w1:p2", "Fix login"]);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
  });

  it("renames a Lark pane and its containing tab", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", cwd: "/repo", agent_status: "idle" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
        if (args[0] === "tab" && args[1] === "get") return json({ tab: { tab_id: "w1:t2", label: "lark_Old pane" } });
        if ((args[0] === "pane" || args[0] === "tab") && args[1] === "rename") return { stdout: "", stderr: "" };
        throw new Error("unexpected args: " + args.join(" "));
      }
    };

    await new HerdrCliAdapter(runner, "herdr", 1000).renamePane("w1:p2", "Better pane", { tabTitle: "Space / Better pane" });
    expect(calls).toContainEqual(["pane", "rename", "w1:p2", "Better pane"]);
    expect(calls).toContainEqual(["tab", "rename", "w1:t2", "lark_Space / Better pane"]);
  });

  it("does not rename a local tab when renaming an attached pane", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", cwd: "/repo", agent_status: "idle" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [] } });
        if (args[0] === "tab" && args[1] === "get") return json({ tab: { tab_id: "w1:t1", label: "local-work" } });
        if (args[0] === "pane" && args[1] === "rename") return { stdout: "", stderr: "" };
        throw new Error("unexpected args: " + args.join(" "));
      }
    };

    await new HerdrCliAdapter(runner, "herdr", 1000).renamePane("w1:p2", "Better pane", { tabTitle: "Better pane" });
    expect(calls).toContainEqual(["pane", "rename", "w1:p2", "Better pane"]);
    expect(calls.some((args) => args[0] === "tab" && args[1] === "rename")).toBe(false);
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

  it("injects a prompt into TraeX and waits for its terminal turn to finish", async () => {
    const calls: string[][] = [];
    const outputs = ["before", "before\n❯ hello", "✧ Working", "answer", "answer", "answer"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "answer", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 1000)).resolves.toBe("done");
    expect(calls).toContainEqual(["agent", "prompt", "w1:p1", "hello"]);
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

  it("completes an unknown-state turn after output returns to a stable idle composer", async () => {
    const calls: string[][] = [];
    const outputs = [
      "◆ Earlier answer\n❯",
      "◆ Earlier answer\n❯ summarize",
      "◆ Earlier answer\n❯ summarize\n◆ Done\n❯"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "◆ Earlier answer\n❯ summarize\n◆ Done\n❯", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "summarize", 2000)).resolves.toBe("done");
    expect(calls).toContainEqual(["agent", "prompt", "w1:p1", "summarize"]);
  });

  it("completes at an idle composer even when the terminal history still contains a working marker", async () => {
    const outputs = [
      "◆ Earlier answer\n❯",
      "◆ Earlier answer\n❯ finish",
      "⚠ Automatic approval review approved\n◆ Working on the task\n◆ Finished\n❯"
    ];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "⚠ Automatic approval review approved\n◆ Working on the task\n◆ Finished\n❯", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }] } });
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "finish", 2000)).resolves.toBe("done");
  });

  it("does not complete an unknown-state turn while an active helper remains", async () => {
    const controller = new AbortController();
    const outputs = ["❯", "❯ build", "◆ Partial output\n❯"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: outputs.shift() ?? "◆ Partial output\n❯", stderr: "" };
        if (args[0] === "pane" && args[1] === "get") return json({ pane: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" } });
        if (args[0] === "pane" && args[1] === "process-info") return json({ process_info: { foreground_processes: [{ name: "traex" }, { name: "systemd-inhibit" }] } });
        return { stdout: "", stderr: "" };
      }
    };
    const turn = new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "build", 60_000, undefined, controller.signal);
    setTimeout(() => controller.abort(), 1100);

    await expect(turn).rejects.toThrow("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed");
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

    await expect(turn).rejects.toThrow("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed");
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

  it("does not report a prompt as dispatched when agent prompt falls back and the composer never echoes it", async () => {
    const calls: string[][] = [];
    let dispatched = 0;
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "prompt") throw new Error('{"error":{"code":"agent_not_ready"}}');
        if (args[0] === "pane" && args[1] === "read") return { stdout: "Select Model and Mode\nPress enter to confirm or esc to go back", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 40).runPrompt("w1:p1", "lost prompt", 1_000, undefined, undefined, () => { dispatched += 1; }))
      .rejects.toThrow("Timed out waiting for prompt text in pane w1:p1");
    expect(dispatched).toBe(0);
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "lost prompt"]);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "send-keys")).toBe(false);
  });

  it("reports direct agent prompt dispatch only after the command succeeds", async () => {
    let dispatched = 0;
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "pane" && args[1] === "read") return { stdout: "before", stderr: "" };
        if (args[0] === "agent" && args[1] === "prompt") throw new Error("transport failed");
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1_000).runPrompt("w1:p1", "hello", 1_000, undefined, undefined, () => { dispatched += 1; }))
      .rejects.toThrow("transport failed");
    expect(dispatched).toBe(0);
  });
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
