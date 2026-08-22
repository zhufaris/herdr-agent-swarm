import { describe, expect, it } from "vitest";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

describe("Herdr adapter", () => {
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
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "hello"]);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);
    const enterIndex = calls.findIndex((args) => args[0] === "pane" && args[1] === "send-keys");
    const readsBeforeEnter = calls.slice(0, enterIndex).filter((args) => args[0] === "pane" && args[1] === "read");
    expect(readsBeforeEnter).toHaveLength(2);
    expect(calls.some((args) => args[0] === "agent" && args[1] === "prompt")).toBe(false);
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
