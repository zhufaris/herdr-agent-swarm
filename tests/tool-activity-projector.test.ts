import { describe, expect, it } from "vitest";
import { projectToolCall, projectToolResult } from "../src/runtime/tool-activity-projector.js";

describe("tool activity projector", () => {
  it.each([
    ["read", "read_file", { path: "src/main.ts" }, "Read", "src/main.ts"],
    ["search", "search", { query: "renderAnswer", path: "src" }, "Search", "renderAnswer · src"],
    ["edit", "apply_patch", { path: "src/cards/run-card.ts" }, "Edit", "src/cards/run-card.ts"],
    ["command", "exec_command", { cmd: "npm test" }, "Command", "npm test"],
    ["wait", "wait", { session_id: 42 }, "Wait", "session 42"],
    ["agent", "collaboration__spawn_agent", { task_name: "review_parser", message: "private prompt" }, "Agent", "review_parser"],
    ["fallback", "future_tool", { payload: "private payload" }, "Tool", "future_tool"]
  ])("classifies a %s call without emitting raw arguments", (_case, name, args, category, target) => {
    const projected = projectToolCall(name, JSON.stringify(args));

    expect(projected.entry).toBe("");
    expect(projected.descriptor).toMatchObject({ category, target });
    expect(JSON.stringify(projected.descriptor)).not.toMatch(/private prompt|private payload/);
  });

  it("recognizes nested exec commands and keeps the target bounded", () => {
    const command = "const r = await tools.exec_command({cmd: '" + "x".repeat(300) + "'}); text(r.output);";
    const projected = projectToolCall("exec", JSON.stringify({ input: command }));

    expect(projected.entry).toBe("");
    expect(projected.descriptor.category).toBe("Command");
    expect(projected.descriptor.target.length).toBeLessThanOrEqual(160);
  });

  it("redacts secrets from command targets", () => {
    const projected = projectToolCall("exec_command", JSON.stringify({
      cmd: "curl -H 'Authorization: Bearer top-secret' https://example.test?token=query-secret"
    }));

    expect(projected.descriptor.target).toContain("[REDACTED]");
    expect(projected.descriptor.target).not.toMatch(/top-secret|query-secret/);
  });

  it("neutralizes embedded backticks inside a command target", () => {
    const projected = projectToolCall("exec_command", JSON.stringify({ cmd: "echo `date`" }));

    expect(projectToolResult(projected.descriptor, "Script completed")).toBe("✓ Command · `echo \\`date\\``");
  });

  it("uses a neutral command target when an exec wrapper cannot be inspected", () => {
    const { descriptor } = projectToolCall("exec", JSON.stringify({ input: "opaque orchestration" }));

    expect(projectToolResult(descriptor, "Script completed")).toBe("✓ Command · `command`");
  });

  it.each([
    ["read_file", { path: "src/main.ts" }, "✓ Read · src/main.ts"],
    ["search", { query: "renderAnswer", path: "src" }, "✓ Search · renderAnswer · src"],
    ["apply_patch", { path: "src/cards/run-card.ts" }, "✓ Edit · src/cards/run-card.ts"],
    ["wait", { session_id: 42 }, "✓ Wait · session 42"],
    ["collaboration__spawn_agent", { task_name: "review_parser" }, "✓ Agent · review_parser"],
    ["future_tool", {}, "✓ Tool · future_tool"]
  ])("renders a unified successful result row for %s", (name, args, expected) => {
    const { descriptor } = projectToolCall(name, JSON.stringify(args));

    expect(projectToolResult(descriptor, "Script completed")).toBe(expected);
  });

  it("defers trusted skill loads and stores only distinct skill names", () => {
    const projected = projectToolCall("exec", JSON.stringify({ input: [
      "/data00/home/alice/.agents/skills/test/SKILL.md",
      "/data00/home/alice/.trae/plugins/cache/pkg/1.0/skills/plugin-guide/SKILL.md",
      "/data00/home/alice/.agents/skills/test/SKILL.md"
    ].join(" ") }));

    expect(projected.entry).toBe("");
    expect(projected.descriptor).toMatchObject({ category: "Skill", target: "test, plugin-guide", skillNames: ["test", "plugin-guide"] });
    expect(JSON.stringify(projected.descriptor)).not.toContain("SKILL.md");
  });

  it("summarizes successful command output without retaining stdout", () => {
    const { descriptor } = projectToolCall("exec_command", JSON.stringify({ cmd: "npm test" }));
    const output = [
      "Script completed", "Wall time 6.8 seconds", "Output:", "private test log",
      "Test Files  69 passed (69)", "Tests  662 passed (662)"
    ].join("\n");

    expect(projectToolResult(descriptor, output)).toBe("✓ Command · `npm test` · 69 files / 662 tests passed");
  });

  it("renders an explicit running result without retaining payload", () => {
    const { descriptor } = projectToolCall("exec_command", JSON.stringify({ cmd: "npm test" }));

    expect(projectToolResult(descriptor, JSON.stringify({ session_id: 42, output: "private partial output" }))).toBe("… Command · `npm test` · 运行中");
  });

  it("retains only a bounded redacted failure tail", () => {
    const { descriptor } = projectToolCall("exec_command", JSON.stringify({ cmd: "npm test" }));
    const lines = Array.from({ length: 30 }, (_, index) => "failure-" + (index + 1));
    lines[29] = "TOKEN=top-secret";
    const output = ["Script failed", "Process exited with code 2", ...lines].join("\n");
    const result = projectToolResult(descriptor, output);

    expect(result).toContain("✗ Command · `npm test` · exit 2");
    expect(result).not.toContain("failure-10\n");
    expect(result).toContain("failure-11");
    expect(result).toContain("TOKEN=[REDACTED]");
    expect(result).not.toContain("top-secret");
    expect(result.length).toBeLessThanOrEqual(4_000);
  });

  it("drops successful skill output completely", () => {
    const { descriptor } = projectToolCall("read_file", JSON.stringify({ path: "/data00/home/alice/.agents/skills/test/SKILL.md" }));

    expect(projectToolResult(descriptor, [{ type: "input_text", text: "Script completed\nOutput:\nfull skill body" }]))
      .toBe("✓ Skill · test");
  });

  it("keeps only bounded diagnostics when a skill load fails", () => {
    const { descriptor } = projectToolCall("read_file", JSON.stringify({ path: "/data00/home/alice/.agents/skills/test/SKILL.md" }));
    const result = projectToolResult(descriptor, "Script failed\nProcess exited with code 1\npermission denied");

    expect(result).toContain("✗ Skill · test · exit 1");
    expect(result).toContain("permission denied");
    expect(result).not.toContain("Script failed");
  });

  it("keeps the closing fence when a failure reaches the character limit", () => {
    const { descriptor } = projectToolCall("exec_command", JSON.stringify({ cmd: "npm test" }));
    const output = "Script failed\nProcess exited with code 1\n" + "x".repeat(5_000);
    const result = projectToolResult(descriptor, output);

    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result.endsWith("```")).toBe(true);
  });

  it("uses a compact fallback for unknown result shapes", () => {
    const { descriptor } = projectToolCall("future_tool", "{}");

    expect(projectToolResult(descriptor, { deeply: { nested: "private payload" } })).toBe("✓ Tool · future_tool");
  });
});
