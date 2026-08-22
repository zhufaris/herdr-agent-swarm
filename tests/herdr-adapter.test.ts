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
});

function json(result: unknown) { return Promise.resolve({ stdout: JSON.stringify({ id: "test", result }), stderr: "" }); }
