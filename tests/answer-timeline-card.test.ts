import { describe, expect, it } from "vitest";
import { renderAnswerTimeline } from "../src/cards/answer-timeline.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

describe("answer timeline card renderer", () => {
  it("keeps Agent messages and collapsed Tool panels in canonical order", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:one", sequence: 1, markdown: "First **thought**" },
      { kind: "tool", id: "tool:one", sequence: 2, category: "read", label: "src/store.ts", resultPreview: "42 lines", state: "succeeded" },
      { kind: "agent_message", id: "message:two", sequence: 3, markdown: "Second message" }
    ];

    const elements = renderAnswerTimeline(items);

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(elements[0]).toMatchObject({ content: "First **thought**" });
    expect(elements[1]).toMatchObject({ expanded: false, border: { color: "grey" }, header: { title: { content: "📖 Read · src/store.ts · ✅" } } });
    expect(elements[2]).toMatchObject({ content: "Second message" });
  });

  it.each([
    ["running", "blue", "⏳"],
    ["succeeded", "grey", "✅"],
    ["failed", "red", "❌"]
  ] as const)("renders %s Tool state consistently", (state, color, label) => {
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:state", sequence: 1, category: "step", label: "custom operation", state }]);
    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false, border: { color }, header: { title: { content: `🔧 Tool · custom operation · ${label}` } } });
    expect(JSON.stringify(panel)).toContain(state === "running" ? "工具仍在运行" : state === "failed" ? "工具执行失败" : "工具已完成，无可展示输出");
  });

  it("renders bounded, redacted command and result detail", () => {
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:command", sequence: 1, category: "command", label: "run tests",
      command: "curl -H 'Authorization: Bearer live-token' https://example.invalid",
      resultPreview: `API_KEY=live-secret\n${"output\n".repeat(2_000)}`, state: "failed"
    }]);
    const serialized = JSON.stringify(panel);

    expect(serialized).toContain("```bash");
    expect(serialized).toContain("```text");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("请在对应 Herdr Pane 查看完整内容");
    expect(serialized).not.toContain("live-token");
    expect(serialized).not.toContain("live-secret");
    expect(serialized.length).toBeLessThan(6_000);
  });

  it("renders write_stdin input as a redacted code-only panel", () => {
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:stdin", sequence: 1, category: "input", label: "session 263",
      command: "echo first\nTOKEN=live-secret\necho second", state: "succeeded"
    }]);
    const serialized = JSON.stringify(panel);

    expect(serialized).toContain("⌨️ Input · session 263 · ✅");
    expect(serialized).toContain("```bash");
    expect(serialized).toContain("echo first");
    expect(serialized).toContain("TOKEN=[REDACTED]");
    expect(serialized).toContain("echo second");
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("```text");
  });

  it("normalizes Agent Markdown and degrades unknown work to a generic step", () => {
    const elements = renderAnswerTimeline([
      { kind: "agent_message", id: "message:safe", sequence: 1, markdown: "safe\u001b[31m red<script>hidden()</script> token=live-secret" },
      { kind: "tool", id: "tool:generic", sequence: 2, category: "step", label: "plugin action", state: "running" }
    ]);
    const serialized = JSON.stringify(elements);

    expect(serialized).toContain("safe red");
    expect(serialized).toContain("🔧 Tool");
    expect(serialized).not.toContain("hidden()");
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("\u001b");
  });

  it("omits process status while preserving Edited tools and final-answer order", () => {
    const elements = renderAnswerTimeline([
      { kind: "status", id: "status:blocked", sequence: 2, label: "Needs local approval", state: "blocked" },
      { kind: "tool", id: "tool:edit", sequence: 3, category: "edit", label: "2 files", state: "succeeded" },
      { kind: "final_answer", id: "final:one", sequence: 4, markdown: "Completed safely." },
      { kind: "agent_message", id: "message:first", sequence: 1, markdown: "Checking." }
    ]);

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(JSON.stringify(elements)).not.toContain("Needs local approval");
    expect(JSON.stringify(elements[1])).toContain("✏️ Edited · 2 files · ✅");
    expect(elements[2]).toMatchObject({ content: "✅ **最终回答**\n\nCompleted safely." });
  });

  it("shows only a summary for Skill calls", () => {
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:skill", sequence: 1, category: "skill", label: "brainstorming",
      resultPreview: "full private SKILL.md body", state: "succeeded"
    }]);
    const serialized = JSON.stringify(panel);

    expect(serialized).toContain("🧩 Skill · brainstorming · ✅");
    expect(serialized).not.toContain("full private SKILL.md body");
  });
});
