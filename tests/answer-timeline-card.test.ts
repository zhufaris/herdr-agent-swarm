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
    expect(elements[1]).toMatchObject({ expanded: false, border: { color: "grey" }, header: { title: { content: "📖 Read · src/store.ts · ✓ 完成" } } });
    expect(elements[2]).toMatchObject({ content: "Second message" });
  });

  it.each([
    ["running", "blue", "… 运行中"],
    ["succeeded", "grey", "✓ 完成"],
    ["failed", "red", "✗ 失败"]
  ] as const)("renders %s Tool state consistently", (state, color, label) => {
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:state", sequence: 1, category: "step", label: "custom operation", state }]);
    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false, border: { color }, header: { title: { content: `🛠️ Step · custom operation · ${label}` } } });
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

  it("normalizes Agent Markdown and degrades unknown work to a generic step", () => {
    const elements = renderAnswerTimeline([
      { kind: "agent_message", id: "message:safe", sequence: 1, markdown: "safe\u001b[31m red<script>hidden()</script> token=live-secret" },
      { kind: "tool", id: "tool:generic", sequence: 2, category: "step", label: "plugin action", state: "running" }
    ]);
    const serialized = JSON.stringify(elements);

    expect(serialized).toContain("safe red");
    expect(serialized).toContain("🛠️ Step");
    expect(serialized).not.toContain("hidden()");
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("\u001b");
  });

  it("renders status and final answer items without reordering", () => {
    const elements = renderAnswerTimeline([
      { kind: "status", id: "status:blocked", sequence: 2, label: "Needs local approval", state: "blocked" },
      { kind: "final_answer", id: "final:one", sequence: 3, markdown: "Completed safely." },
      { kind: "agent_message", id: "message:first", sequence: 1, markdown: "Checking." }
    ]);

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(JSON.stringify(elements[1])).toContain("⚠️ 等待用户处理");
    expect(elements[2]).toMatchObject({ content: "Completed safely." });
  });
});
