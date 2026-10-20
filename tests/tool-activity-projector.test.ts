import { describe, expect, it } from "vitest";
import { isAnswerVisibleToolActivity, isStatusVisibleToolActivity, nestedExecCommands, nestedPatchFiles, normalizeToolOutput, normalizeToolResultForDisplay, projectToolCall, projectToolCalls, projectToolResultState, summarizeToolActivity, toolActivityKey } from "../src/runtime/tool-activity-projector.js";

describe("tool activity projector", () => {
  it.each([
    ["read", "read_file", { path: "src/main.ts" }, "Read", "src/main.ts"],
    ["search", "search", { query: "renderAnswer", path: "src" }, "Search", "renderAnswer · src"],
    ["edit", "apply_patch", { path: "src/cards/run-card.ts" }, "Edit", "src/cards/run-card.ts"],
    ["command", "exec_command", { cmd: "npm test" }, "Command", "npm test"],
    ["skill", "exec_command", { cmd: "sed -n 1,200p /tmp/data00/" + "home/alice/.trae/skills/herdr/SKILL.md" }, "Skill", "herdr"],
    ["wait", "wait", { session_id: 42 }, "Wait", "session 42"],
    ["agent", "collaboration__spawn_agent", { task_name: "review_parser", message: "private prompt" }, "Agent", "review_parser"],
    ["fallback", "future_tool", { payload: "private payload" }, "Tool", "future_tool"]
  ])("classifies a %s call without retaining raw arguments", (_case, name, args, category, target) => {
    const projected = projectToolCall(name, JSON.stringify(args));

    expect(projected.descriptor).toMatchObject({ category, target });
    expect(JSON.stringify(projected.descriptor)).not.toMatch(/private prompt|private payload/);
  });

  it("recognizes nested exec commands and keeps the target bounded", () => {
    const command = "const r = await tools.exec_command({cmd: '" + "x".repeat(300) + "'}); text(r.output);";
    const projected = projectToolCall("exec", JSON.stringify({ input: command }));

    expect(projected.descriptor.category).toBe("Command");
    expect(projected.descriptor.target.length).toBeLessThanOrEqual(160);
  });

  it("extracts every static command from a Promise.all Code Mode wrapper", () => {
    const input = [
      "const results = await Promise.all([",
      "  tools.exec_command({ cmd: \"sqlite3 bridge.db SELECT-1\" }),",
      "  tools.exec_command({cmd: 'npm test -- --runInBand'})",
      "]); text(results);"
    ].join("\n");

    expect(nestedExecCommands(input)).toEqual([
      "sqlite3 bridge.db SELECT-1",
      "npm test -- --runInBand"
    ]);
    expect(projectToolCall("exec", JSON.stringify({ input })).descriptor).toMatchObject({
      category: "Command", target: expect.stringContaining("sqlite3 bridge.db")
    });
    expect(projectToolCall("functions.exec", JSON.stringify({ input })).descriptor).toMatchObject({
      category: "Command", target: expect.stringContaining("sqlite3 bridge.db")
    });
  });

  it("projects the raw Code Mode input emitted by Herdr Core events", () => {
    const input = "const r = await tools.exec_command({cmd: 'git status --short'}); text(r.output);";

    expect(projectToolCall("exec", input).descriptor).toMatchObject({
      category: "Command",
      target: "git status --short"
    });
  });

  it("extracts edited file identities from a raw Code Mode apply_patch call", () => {
    const input = "const patch = \"*** Begin Patch\\n*** Update File: /repo/src/main.ts\\n@@\\n-old\\n+new\\n*** Add File: /repo/tests/main.test.ts\\n+test\\n*** End Patch\"; text(await tools.apply_patch(patch));";

    expect(nestedPatchFiles(input)).toEqual(["main.ts", "main.test.ts"]);
    expect(projectToolCall("exec", input).descriptor).toMatchObject({
      category: "Edit", target: "main.ts (+1 -1), main.test.ts (+1 -0)",
      diff: [
        "*** Update File: /repo/src/main.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: /repo/tests/main.test.ts",
        "+test"
      ].join("\n")
    });
  });

  it("retains the sanitized diff from a direct apply_patch call", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /repo/.env.example",
      "@@",
      "-TOKEN=old-value",
      "+TOKEN=new-value",
      "*** End Patch"
    ].join("\n");

    const projected = projectToolCall("apply_patch", patch);

    expect(projected.descriptor).toMatchObject({
      category: "Edit",
      target: "apply_patch",
      diff: expect.stringContaining("TOKEN=[REDACTED]")
    });
    expect(projected.descriptor.diff).not.toMatch(/old-value|new-value/);
  });

  it("omits diff detail when a Code Mode wrapper contains multiple patches", () => {
    const input = [
      'const first = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n@@\\n-old-a\\n+new-a\\n*** End Patch";',
      "await tools.apply_patch(first);",
      'const second = "*** Begin Patch\\n*** Update File: /repo/b.ts\\n@@\\n-old-b\\n+new-b\\n*** End Patch";',
      "await tools.apply_patch(second);"
    ].join(" ");

    const projected = projectToolCalls("exec", input);

    expect(projected).toHaveLength(3);
    expect(projected.filter(({ descriptor }) => descriptor.category === "Edit")).toEqual([
      expect.objectContaining({ descriptor: expect.not.objectContaining({ diff: expect.anything() }) }),
      expect.objectContaining({ descriptor: expect.not.objectContaining({ diff: expect.anything() }) })
    ]);
  });

  it.each([
    ["malformed apply_patch", "apply_patch", "*** Begin Patch\n*** Update File: /repo/a.ts\n+unfinished"],
    ["non-patch edit", "write_file", JSON.stringify({ path: "/repo/a.ts", content: "new file" })]
  ])("omits diff detail for %s input", (_case, name, input) => {
    expect(projectToolCall(name, input).descriptor).not.toHaveProperty("diff");
  });

  it("does not project Tool-looking source text inside an apply_patch string", () => {
    const input = [
      "const patch = `*** Begin Patch",
      "*** Update File: /repo/tests/main.test.ts",
      "@@",
      "+const image = await tools.view_image({path: '/tmp/not-executed.png'});",
      "+const search = await tools.web_search({query: 'not executed'});",
      "*** End Patch`;",
      "text(await tools.apply_patch(patch));"
    ].join("\n");

    const projected = projectToolCalls("exec", input);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual({ descriptor: {
      category: "Edit",
      target: "main.test.ts (+2 -0)",
      skillNames: [],
      diff: [
        "*** Update File: /repo/tests/main.test.ts",
        "@@",
        "+const image = await tools.view_image({path: '/tmp/not-executed.png'});",
        "+const search = await tools.web_search({query: 'not executed'});"
      ].join("\n")
    } });
  });

  it.each([
    ["read", "const r = await tools.view_image({path: '/tmp/screen.png'}); image(r.image_url);", "Read", "/tmp/screen.png"],
    ["search", "const r = await tools.web_search({query: 'CardKit'}); text(r);", "Search", "CardKit"],
    ["command", "const r = await tools.exec_command({cmd: 'npm run build'}); text(r.output);", "Command", "npm run build"],
    ["wait", "const r = await tools.write_stdin({session_id: 42}); text(r.output);", "Wait", "write_stdin"],
    ["agent", "const r = await tools.collaboration__spawn_agent({task_name: 'reviewer'}); text(r);", "Agent", "reviewer"],
    ["fallback", "const r = await tools.future_tool({target: 'widget'}); text(r);", "Tool", "future_tool"]
  ])("classifies a raw Code Mode %s call", (_case, input, category, target) => {
    expect(projectToolCall("exec", input).descriptor).toMatchObject({ category, target });
  });

  it("keeps Wait, Command, and Agent tool activity in the Answer timeline", () => {
    const wait = projectToolCall("write_stdin", JSON.stringify({ session_id: 42 })).descriptor;
    const command = projectToolCall("exec_command", JSON.stringify({ cmd: "npm test" })).descriptor;
    const agent = projectToolCall("collaboration__list_agents", "{}").descriptor;
    expect(isStatusVisibleToolActivity(wait)).toBe(true);
    expect(isAnswerVisibleToolActivity(wait)).toBe(true);
    expect(summarizeToolActivity(wait)).toBe("Wait · session 42");
    expect(isStatusVisibleToolActivity(command)).toBe(true);
    expect(isAnswerVisibleToolActivity(command)).toBe(true);
    expect(isStatusVisibleToolActivity(agent)).toBe(true);
    expect(isAnswerVisibleToolActivity(agent)).toBe(true);
    expect(toolActivityKey("poll-1", wait)).toBe("wait:session 42");
    expect(toolActivityKey("poll-2", wait)).toBe("wait:session 42");
  });

  it("redacts secrets from command targets", () => {
    const projected = projectToolCall("exec_command", JSON.stringify({
      cmd: "curl -H 'Authorization: Bearer top-secret' https://example.test?token=query-secret"
    }));

    expect(projected.descriptor.target).toContain("[REDACTED]");
    expect(projected.descriptor.target).not.toMatch(/top-secret|query-secret/);
  });

  it("summarizes long database commands without losing the command target", () => {
    const command = `sqlite3 -readonly -header -column /tmp/bridge.db "SELECT ${"many_columns,".repeat(30)} id FROM outbound_replies"`;
    const descriptor = projectToolCall("exec_command", JSON.stringify({ cmd: command })).descriptor;

    expect(summarizeToolActivity(descriptor)).toBe("Query · bridge.db");
    expect(descriptor.target).toContain("sqlite3 -readonly");
    expect(summarizeToolActivity(descriptor).length).toBeLessThan(40);
  });

  it("ignores redacted environment assignments when summarizing a test command", () => {
    const descriptor = projectToolCall("exec_command", JSON.stringify({ cmd: "TOKEN=top-secret npm test" })).descriptor;
    expect(summarizeToolActivity(descriptor)).toBe("Test · project");
  });

  it("stores only distinct trusted skill names", () => {
    const userSkillRoot = "/data00/" + "home/alice";
    const projected = projectToolCall("exec", JSON.stringify({ input: [
      userSkillRoot + "/.agents/skills/test/SKILL.md",
      userSkillRoot + "/.trae/plugins/cache/pkg/1.0/skills/plugin-guide/SKILL.md",
      userSkillRoot + "/.agents/skills/test/SKILL.md"
    ].join(" ") }));

    expect(projected.descriptor).toMatchObject({ category: "Skill", target: "test, plugin-guide", skillNames: ["test", "plugin-guide"] });
    expect(JSON.stringify(projected.descriptor)).not.toContain("SKILL.md");
  });

  it.each([
    [JSON.stringify({ session_id: 42, output: "partial" }), "active"],
    [JSON.stringify({ exit_code: 0, output: "done" }), "done"],
    [JSON.stringify({ exit_code: 2, output: "failed" }), "failed"],
    ["Script failed\nProcess exited with code 1", "failed"]
  ])("projects a structured result state", (output, expected) => {
    expect(projectToolResultState(output)).toBe(expected);
  });

  it("normalizes text content without rendering Markdown", () => {
    expect(normalizeToolOutput([{ type: "input_text", text: " first " }, { type: "output_text", text: "second" }])).toBe("first\nsecond");
    expect(normalizeToolOutput({ private: "payload" })).toBe("");
  });

  it("unwraps standard execution headers and nested structured tool outputs", () => {
    const nested = JSON.stringify({
      plan: {},
      test: { chunk_id: "chunk-1", exit_code: 0, output: "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh", wall_time_seconds: 1.2 }
    });
    expect(normalizeToolOutput([
      { type: "input_text", text: "Script completed\nWall time 0.5 seconds\nOutput:" },
      { type: "input_text", text: nested }
    ])).toBe("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh");
  });

  it("preserves ordinary JSON that is not a standard tool result envelope", () => {
    expect(normalizeToolOutput(JSON.stringify({ project: "herdr-agent-swarm", healthy: true })))
      .toBe('{"project":"herdr-agent-swarm","healthy":true}');
  });

  it("treats an empty structured Tool result as no displayable output", () => {
    expect(normalizeToolOutput("{}")).toBe("");
    expect(normalizeToolResultForDisplay(JSON.stringify({ exit_code: 0, output: "token=live-secret" }), true))
      .toBe("token=[REDACTED]\n\n… source event truncated");
  });
});
