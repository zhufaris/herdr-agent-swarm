import { describe, expect, it } from "vitest";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

describe("Herdr adapter", () => {
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
    const outputs = ["before", "✧ Working", "answer", "answer", "answer"];
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "read") return { stdout: outputs.shift() ?? "answer", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    };

    await expect(new HerdrCliAdapter(runner, "herdr", 1000).runPrompt("w1:p1", "hello", 1000)).resolves.toBe("done");
    expect(calls).toContainEqual(["pane", "send-text", "w1:p1", "hello"]);
    expect(calls).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);
    expect(calls.some((args) => args[0] === "agent" && args[1] === "prompt")).toBe(false);
  });

  it("keeps the turn open while approval is blocked and completes after approval", async () => {
    const states = ["working", "blocked", "blocked", "working", "done"] as const;
    const observed: Array<{ state: string; output: string }> = [];
    const runner: CommandRunner = {
      async run(_executable, args) {
        if (args[0] === "agent" && args[1] === "read") return { stdout: "terminal", stderr: "" };
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
    expect(observed.every(({ output }) => output === "terminal")).toBe(true);
  });

  it("steers only while structured pane state is working", async () => {
    const calls: string[][] = [];
    let state: "working" | "blocked" = "working";
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
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
    const runner: CommandRunner = {
      async run(_executable, args) {
        calls.push(args);
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
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
