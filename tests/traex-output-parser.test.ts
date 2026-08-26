import { describe, expect, it } from "vitest";
import { extractFinalTraexAnswer, parseTerminalStreamDelta, parseTraexOutput } from "../src/runtime/traex-output-parser.js";

describe("TraeX output parser", () => {
  it("appends newly visible terminal output once and redacts secrets in place", () => {
    const previous = "› deploy\n✧ Working\n• Read /repo/src/a.ts";
    const current = `${previous}\n• Bash curl -H 'Authorization: Bearer secret-token' /health\nHTTP 200\n◆ Deployment healthy`;

    const first = parseTerminalStreamDelta(previous, current, "deploy");
    expect(first.delta).toBe("• Bash curl -H 'Authorization: Bearer [REDACTED]' /health\nHTTP 200\n◆ Deployment healthy");
    expect(first.update).toBe("append");
    expect(first.snapshot).toBe(current);
    expect(parseTerminalStreamDelta(current, current, "deploy").delta).toBe("");
  });

  it("extracts trusted model and context telemetry without exposing it as answer prose", () => {
    const status = "GPT-5.6-Sol · Auto Mode · 31.1K tokens";

    expect(parseTerminalStreamDelta(status, status, "inspect")).toMatchObject({
      delta: "", model: "GPT-5.6-Sol", context: "31.1K tokens"
    });
  });

  it("extracts telemetry only from the bounded terminal tail", () => {
    const early = "GPT-5.6-Sol · Auto Mode · 1K tokens";
    const tail = ["GPT-5.6-Terra · Auto Mode · 31.1K tokens", ...Array.from({ length: 39 }, (_, index) => `tail ${index}`)].join("\n");

    expect(parseTerminalStreamDelta("", `${early}\n${tail}`, "inspect")).toMatchObject({
      model: "GPT-5.6-Terra", context: "31.1K tokens"
    });
  });

  it("replaces a redrawn terminal snapshot instead of appending the full screen again", () => {
    const previous = ["◆ First answer", "✧ Working"].join("\n");
    const current = [
      "╭───────────────────────────╮",
      "│ ▄▄▄▄▄▄▄                   │",
      "│ █ ◆ ◆ █  TraeCode CLI (v1) │",
      "│ Good morning, feiyu.zhu   │",
      "╰───────────────────────────╯",
      "◆ Current answer",
      "────────────────────────────",
      "❯ Use /skills to list available skills",
      "GPT-5.6-Sol · Auto Mode"
    ].join("\n");

    expect(parseTerminalStreamDelta(previous, current, "tidy code")).toMatchObject({
      delta: "◆ Current answer",
      update: "replace-all"
    });
  });

  it("keeps only the new suffix after a long redrawn-snapshot overlap", () => {
    const overlap = `${"terminal row\n".repeat(100)}◆ Shared live status`;
    const previous = `stale header\n${overlap}`;
    const current = `${overlap}\n◆ New live status`;

    expect(parseTerminalStreamDelta(previous, current, "inspect")).toMatchObject({
      delta: "◆ New live status", update: "append"
    });
  });

  it("preserves incomplete and non-TraeCode terminal boxes", () => {
    const nonTraeCodeBox = [
      "╭───────────────────────────╮",
      "│ Build output              │",
      "╰───────────────────────────╯",
      "◆ Keep this result"
    ].join("\n");
    const incompleteBox = [
      "╭───────────────────────────╮",
      "│ TraeCode CLI (v1)         │",
      "◆ Keep incomplete output"
    ].join("\n");

    expect(parseTerminalStreamDelta("previous", nonTraeCodeBox, "inspect").delta).toContain(nonTraeCodeBox);
    expect(parseTerminalStreamDelta("previous", incompleteBox, "inspect").delta).toContain(incompleteBox);
  });

  it("drops a narrow composer echo and unwraps terminal-width prose for Lark", () => {
    const current = [
      "▍ t", "▍ i", "▍ d", "▍ y", "▍  ", "▍ c", "▍ o", "▍ d", "▍ e",
      "◆ 已完成代", "码整理并", "通过测试。"
    ].join("\n");

    expect(parseTerminalStreamDelta("", current, "tidy code")).toMatchObject({
      delta: "◆ 已完成代码整理并通过测试。",
      update: "append"
    });
  });

  it("removes the native subagent console from live answer output", () => {
    const current = [
      "◆ 汇总并复核并行审查发现",
      "5 agents running… · /ps to manage",
      "● Main [default] running · 20m4s",
      "● Helmholtz [default] running · 10m21s",
      "↓ to select agents",
      "… +1 completed",
      "◆ 已完成复核并整理修复建议"
    ].join("\n");

    const { delta } = parseTerminalStreamDelta("", current, "review");
    expect(delta).toContain("◆ 汇总并复核并行审查发现");
    expect(delta).toContain("◆ 已完成复核并整理修复建议");
    expect(delta).not.toContain("agents running");
    expect(delta).not.toContain("Main [default]");
    expect(delta).not.toContain("Helmholtz [default]");
    expect(delta).not.toContain("to select agents");
  });

  it("keeps status, tools, shell output, and approval choices", () => {
    const current = [
      "\u001b[32m✧ Working\u001b[0m",
      "• Read /repo/src/a.ts",
      "• Edit /repo/src/b.ts",
      "• Bash npm test",
      "PASS tests/a.test.ts",
      "Approve command?",
      "1. Allow once",
      "2. Deny",
      "<think>private chain</think>",
      "◆ Finished"
    ].join("\n");

    const { delta } = parseTerminalStreamDelta("", current, "unrelated prompt");
    expect(delta).toContain("✧ Working");
    expect(delta).toContain("• Read /repo/src/a.ts");
    expect(delta).toContain("PASS tests/a.test.ts");
    expect(delta).toContain("Approve command?\n1. Allow once\n2. Deny");
    expect(delta).toContain("◆ Finished");
    expect(delta).not.toContain("private chain");
    expect(delta).not.toContain("\u001b");
  });

  it("reconstructs terminal-wrapped tool headings without flattening tool output", () => {
    const current = [
      "◆ Ran sqli",
      "  │ te3",
      "  └ database result",
      "◆ Read 2",
      "  │  files",
      "```text",
      "keep",
      "line breaks",
      "```"
    ].join("\n");

    expect(parseTerminalStreamDelta("", current, "inspect").delta).toBe([
      "◆ Ran sqlite3",
      "  └ database result",
      "◆ Read 2 files",
      "```text",
      "keep",
      "line breaks",
      "```"
    ].join("\n"));
  });

  it("replaces an oversized live delta with its newest user-facing window", () => {
    const newest = "◆ Final live status: all focused tests passed";
    const oversized = `very first live output\n${"older output\n".repeat(1_100)}${newest}`;

    const parsed = parseTerminalStreamDelta("previous terminal window", oversized, "run tests");

    expect(parsed.update).toBe("replace-all");
    expect(parsed.delta).toContain("较早的实时输出已省略，以下为最新状态。");
    expect(parsed.delta).toContain(newest);
    expect(parsed.delta).not.toContain("[OUTPUT TRUNCATED]");
    expect(parsed.delta).not.toContain("very first live output");
  });

  it("extracts answer growth and normalized safe progress", () => {
    const previous = "✧ Working\n• Read /repo/src/a.ts\n◆ Fixed";
    const current = "✧ Working\n• Read /repo/src/a.ts\n• Edit /repo/src/b.ts\n• Bash npm test\n◆ Fixed login safely";
    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({
      answerSnapshot: "Fixed login safely",
      progressEvents: [],
      hasProgressSnapshot: false
    });
  });

  it("omits reasoning, tool JSON, and credential-shaped content", () => {
    const unsafe = '<think>secret plan</think>\n{"command":"curl","Authorization":"Bearer abc123"}\nPRIVATE KEY-----\n• Bash echo $TOKEN';
    expect(parseTraexOutput("", unsafe, "/repo")).toMatchObject({ answerSnapshot: "", progressEvents: [], hasProgressSnapshot: false });
  });

  it("uses the latest answer block for a later turn", () => {
    expect(extractFinalTraexAnswer("◆ answer 1\n────────\n◆ answer 2\n────────")).toBe("answer 2");
  });

  it("stops the latest answer at its first terminal separator", () => {
    expect(extractFinalTraexAnswer("◆ answer\n────────\nolder terminal content\n────────")).toBe("answer");
  });

  it("extracts the latest answer without retaining prior answer matches", () => {
    const output = Array.from({ length: 100 }, (_, index) => `◆ historical answer ${index}\n────────`).join("\n");
    expect(extractFinalTraexAnswer(`${output}\n◆ final answer\n────────`)).toBe("final answer");
  });

  it("filters subagent console status from the final answer", () => {
    expect(extractFinalTraexAnswer([
      "◆ Review complete",
      "5 agents running… · /ps to manage",
      "● Main [default] running · 20m",
      "────────"
    ].join("\n"))).toBe("Review complete");
  });

  it("preserves ordinary status bullets in the final answer", () => {
    expect(extractFinalTraexAnswer([
      "◆ 发布检查：",
      "● Build done",
      "● Smoke test done",
      "────────"
    ].join("\n"))).toBe("发布检查：\n● Build done\n● Smoke test done");
  });

  it("marks a newly appended answer block separately from growth of the current block", () => {
    const first = "◆ First message";
    expect(parseTraexOutput(first, `${first} continues`, "/repo")).toMatchObject({ answerSnapshot: "First message continues", answerUpdate: "replace" });
    expect(parseTraexOutput(first, `${first}\n◆ Second message`, "/repo")).toMatchObject({ answerSnapshot: "Second message", answerUpdate: "append" });
  });

  it("does not replay an unchanged answer from before the current prompt", () => {
    const previous = "◆ Previous turn answer\n────────";
    const current = `${previous}\n✧ Working`;

    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({ answerSnapshot: "", answerUpdate: "replace" });
  });

  it("returns the latest TraeX status frame as one replaceable snapshot", () => {
    const previous = "◆ 重新构建部署并重放 Query Log 与 Aeolus Chart… (35m 10s • ↓ 30.8K tokens)\n  9 tasks (7 done, 1 in progress, 1 open)\n  ■ 重新构建部署并重放 Query Log 与 Aeolus Chart\n  ◻ 更新 PROGRESS.md";
    const current = "◆ 重新构建部署并重放 Query Log 与 Aeolus Chart… (35m 20s • ↓ 31.1K tokens)\n  9 tasks (8 done, 1 in progress, 0 open)\n  ✔ 重新构建部署并重放 Query Log 与 Aeolus Chart\n  ■ 更新 PROGRESS.md";

    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({
      answerSnapshot: current.slice(2), answerUpdate: "replace-status", hasProgressSnapshot: true,
      progressEvents: [
        { key: "native:0:重新构建部署并重放 Query Log 与 Aeolus Chart", label: "重新构建部署并重放 Query Log 与 Aeolus Chart", state: "done" },
        { key: "native:1:更新 PROGRESS.md", label: "更新 PROGRESS.md", state: "active" }
      ]
    });
  });

  it("bounds native task progress and ignores status-like prose without task rows", () => {
    const rows = Array.from({ length: 25 }, (_, index) => `${index === 0 ? "■" : "◻"} Step ${index}`).join("\n");
    const parsed = parseTraexOutput("", `◆ Work (1m • 2K tokens)\n25 tasks (0 done, 1 in progress, 24 open)\n${rows}`, "/repo");

    expect(parsed.progressEvents).toHaveLength(20);
    expect(parsed.progressEvents[0]).toMatchObject({ label: "Step 0", state: "active" });
    expect(parsed.progressEvents.at(-1)).toMatchObject({ label: "Step 19", state: "pending" });
    expect(parseTraexOutput("", "◆ Work (1m • 2K tokens)\n2 tasks (1 done, 1 open)", "/repo")).toMatchObject({ hasProgressSnapshot: false, progressEvents: [] });
  });

  it("recognizes a terminal-wrapped native frame and keeps duplicate labels distinct", () => {
    const wrapped = [
      "◆ Rebuild deployment and replay Query Log",
      "  and Aeolus Chart…",
      "  (35m 20s • ↓ 31.1K tokens • esc to interrupt)",
      "  4 tasks (1 done, 1 in progress, 1 open, 1 failed)",
      "  ✔ Validate",
      "  ■ Validate",
      "  ◻ Publish",
      "  ✕ Recover"
    ].join("\n");

    expect(parseTraexOutput("", wrapped, "/repo")).toMatchObject({
      answerUpdate: "replace-status", hasProgressSnapshot: true,
      progressEvents: [
        { key: "native:0:Validate", label: "Validate", state: "done" },
        { key: "native:1:Validate", label: "Validate", state: "active" },
        { key: "native:2:Publish", label: "Publish", state: "pending" },
        { key: "native:3:Recover", label: "Recover", state: "failed" }
      ]
    });
  });

  it("joins terminal-wrapped native task labels into one progress line", () => {
    const wrapped = [
      "◆ Run bridge checks (1m • 2K tokens)",
      "  2 tasks (0 done, 1 in progress, 1 open)",
      "  ■ Run npm test -- --runInBand for the lark card renderer and",
      "    verify /data00/home/feiyu.zhu/work/herdr-lark-bridge output",
      "  ◻ 发布修复"
    ].join("\n");

    expect(parseTraexOutput("", wrapped, "/repo").progressEvents).toMatchObject([
      { label: "Run npm test -- --runInBand for the lark card renderer and verify /data00/home/feiyu.zhu/work/herdr-lark-bridge output", state: "active" },
      { label: "发布修复", state: "pending" }
    ]);
  });
});
