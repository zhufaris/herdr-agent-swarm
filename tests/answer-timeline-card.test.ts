import { describe, expect, it } from "vitest";
import { renderAnswerTimeline } from "../src/cards/answer-timeline.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

describe("answer timeline card renderer", () => {
  it("renders semantic successes as compact rows and expands timeout diagnostics", () => {
    const [success] = renderAnswerTimeline([{
      kind: "tool", id: "tool:success", sequence: 1, category: "test", label: "legacy label",
      action: "Test", target: "npm test", result: "240 tests passed",
      resultSummary: { outcome: "success", text: "240 tests passed" }, state: "succeeded"
    }]);
    expect(success).toEqual({ tag: "markdown", content: "🧪 Test · npm test · ✓ 完成" });

    const [timeout] = renderAnswerTimeline([{
      kind: "tool", id: "tool:timeout", sequence: 1, category: "command", label: "legacy label",
      action: "Build", target: "npm run build", command: "npm run build", result: "connection timed out",
      resultSummary: { outcome: "timeout", text: "connection timed out" }, state: "failed"
    }]);
    expect(timeout).toMatchObject({
      tag: "collapsible_panel", expanded: true, border: { color: "orange" },
      header: { title: { content: "⚙️ Build · npm run build · ⏱ 超时" } },
      elements: [{ content: expect.stringContaining("connection timed out") }]
    });
  });

  it("expands an aggregate Tool when a child reports a timeout", () => {
    const [group] = renderAnswerTimeline([
      { kind: "tool", id: "tool:outer", sequence: 1, category: "tool", label: "exec", action: "Tool", target: "exec", state: "succeeded" },
      { kind: "tool", id: "tool:child", parentToolId: "tool:outer", sequence: 2, category: "command", label: "npm run build", action: "Build", target: "npm run build", resultSummary: { outcome: "timeout", text: "deadline exceeded" }, state: "failed" }
    ]);
    expect(group).toMatchObject({ tag: "collapsible_panel", expanded: true, border: { color: "orange" } });
    expect(JSON.stringify(group)).toContain("deadline exceeded");
  });

  it("expands a semantic failed Tool without a result summary", () => {
    const [failed] = renderAnswerTimeline([{
      kind: "tool", id: "tool:failed", sequence: 1, category: "command", label: "legacy label",
      action: "Build", target: "npm run build", state: "failed"
    }]);
    expect(failed).toMatchObject({ tag: "collapsible_panel", expanded: true, border: { color: "red" } });
  });

  it("shows only failed child diagnostics in an expanded aggregate and puts Summary first", () => {
    const [group] = renderAnswerTimeline([
      { kind: "tool", id: "tool:outer", sequence: 1, category: "tool", label: "exec", action: "Tool", target: "exec", state: "succeeded" },
      { kind: "tool", id: "tool:success-child", parentToolId: "tool:outer", sequence: 2, category: "command", label: "npm test", action: "Test", target: "npm test", result: "SUCCESS-SHOULD-STAY-HIDDEN", resultSummary: { outcome: "success", text: "all tests passed" }, state: "succeeded" },
      { kind: "tool", id: "tool:failure-child", parentToolId: "tool:outer", sequence: 3, category: "command", label: "npm run build", action: "Build", target: "npm run build", result: "RAW-FAILURE-DETAIL", resultSummary: { outcome: "failure", text: "SUMMARY-FIRST" }, state: "failed" }
    ]);
    const content = group?.tag === "collapsible_panel" ? group.elements[0]?.content ?? "" : "";
    expect(content).toContain("**Summary**\n\nSUMMARY-FIRST");
    expect(content.indexOf("SUMMARY-FIRST")).toBeLessThan(content.indexOf("RAW-FAILURE-DETAIL"));
    expect(content).not.toContain("SUCCESS-SHOULD-STAY-HIDDEN");
  });

  it("uses canonical sequence rather than lexicographic item IDs", () => {
    expect(() => renderAnswerTimeline([
      { kind: "agent_message", id: "z-item", sequence: 2, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }, markdown: "second" },
      { kind: "agent_message", id: "a-item", sequence: 1, canonicalPosition: { laneSequence: 1, itemOrdinal: 0 }, markdown: "first" }
    ])).toThrow("strictly increasing canonical order");
  });
  it("keeps Agent messages and collapsed Tool panels in canonical order", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:one", sequence: 1, markdown: "First **thought**" },
      { kind: "tool", id: "tool:one", sequence: 2, category: "read", label: "src/store.ts", resultPreview: "42 lines", state: "succeeded" },
      { kind: "agent_message", id: "message:two", sequence: 3, markdown: "Second message" }
    ];

    const elements = renderAnswerTimeline(items);

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(elements[0]).toMatchObject({ content: "🤖First **thought**" });
    expect(elements[1]).toMatchObject({ expanded: false, border: { color: "grey" }, header: { title: { content: "📖 Read src/store.ts" } } });
    expect(elements[2]).toMatchObject({ content: "🤖Second message" });
  });

  it("keeps human messages out of the Answer body because the header owns reply context", () => {
    const elements = renderAnswerTimeline([
      { kind: "human_message", id: "human:one", sequence: 1, markdown: "Continue the check." },
      { kind: "agent_message", id: "message:one", sequence: 2, markdown: "Checking now." }
    ]);

    expect(elements).toEqual([{ tag: "markdown", content: "🤖Checking now." }]);
  });

  it("renders a final answer without terminal memory citation metadata", () => {
    const item = {
      kind: "final_answer", id: "final:memory", sequence: 1,
      markdown: "Visible answer\n\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>"
    } as const;
    const elements = renderAnswerTimeline([item]);

    expect(elements).toEqual([{ tag: "markdown", content: "Visible answer" }]);
    expect(item.markdown).toContain("<oai-mem-citation>");
  });

  it("renders the latest Subagent activity content under its lifecycle status", () => {
    const [element] = renderAnswerTimeline([{
      kind: "status", id: "agent:reviewer", sequence: 1,
      label: "Agent · Reviewer · GPT-5.6-Sol", state: "completed",
      detail: "Verified the recovery path.", detailTruncated: false
    }]);

    expect(element).toMatchObject({
      tag: "collapsible_panel",
      header: { title: { content: expect.stringContaining("Agent completed") } },
      elements: [{ content: "Verified the recovery path." }]
    });
  });

  it("redacts and marks truncated Subagent activity content", () => {
    const [element] = renderAnswerTimeline([{
      kind: "status", id: "agent:reviewer", sequence: 1,
      label: "Agent · Reviewer", state: "running",
      detail: "Checking API_KEY=live-secret", detailTruncated: true
    }]);
    const rendered = JSON.stringify(element);
    expect(rendered).toContain("Checking API_KEY=[REDACTED]");
    expect(rendered).toContain("source event truncated");
    expect(rendered).not.toContain("live-secret");
  });

  it("omits a legacy persisted update_plan Tool and its empty Result", () => {
    const elements = renderAnswerTimeline([
      { kind: "tool", id: "tool:plan", sequence: 1, category: "step", label: "update_plan", result: "{}", state: "succeeded" },
      { kind: "agent_message", id: "message:one", sequence: 2, markdown: "Plan updated." }
    ]);

    expect(elements).toEqual([{ tag: "markdown", content: "🤖Plan updated." }]);
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

  it("renders a legacy Step like a tool while retaining its command and compact result", () => {
    const result = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:step", sequence: 1, category: "step", label: "Run command",
      command: "git status --short", result, state: "succeeded"
    }]);

    expect(panel).toMatchObject({
      tag: "collapsible_panel", expanded: false,
      header: { title: { content: "🛠️ Step · Run command · ✓ 完成" } },
      elements: [{ content: expect.stringContaining("**Command**\n\n```bash\ngit status --short\n```") }]
    });
    const serialized = JSON.stringify(panel);
    expect(serialized).toContain("line-1");
    expect(serialized).toContain("line-3");
    expect(serialized).toContain("… +2 lines omitted");
    expect(serialized).toContain("line-6");
    expect(serialized).toContain("line-8");
  });

  it.each(["tool", "step"] as const)("renders %s commands as fenced Markdown inside a collapsible panel", (category) => {
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: `tool:${category}`, sequence: 1, category, label: "Run checks",
      command: "npm test -- --runInBand", state: "succeeded"
    }]);

    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(JSON.stringify(panel)).toContain("**Command**\\n\\n```bash\\nnpm test -- --runInBand\\n```");
  });

  it.each([
    ["read", "📖 Read target"],
    ["search", "🔍 Searched for target"],
    ["edit", "✏️ Edited target"],
    ["command", "⚙️ Ran target"],
    ["test", "🧪 Ran target"],
    ["skill", "🧩 Loaded skill target"],
    ["tool", "🔧 Tool · target · ✓ 完成"],
    ["step", "🛠️ Step · target · ✓ 完成"]
  ] as const)("renders the %s Tool type with its stable CardKit emoji", (category, expected) => {
    const [element] = renderAnswerTimeline([{ kind: "tool", id: `tool:${category}`, sequence: 1, category, label: "target", state: "succeeded" }]);
    expect(JSON.stringify(element)).toContain(expected);
  });

  it("advances the running Tool indicator on existing card update frames", () => {
    const item: AnswerTimelineItem = { kind: "tool", id: "tool:active", sequence: 1, category: "command", label: "npm test", command: "npm test", state: "running" };
    const titles = [0, 1, 2].map((frame) => {
      const [panel] = renderAnswerTimeline([item], undefined, frame);
      return panel?.tag === "collapsible_panel" ? panel.header.title.content : "";
    });

    expect(titles).toEqual([
      "🔄 ⚙️ Running npm test…",
      "⏳ ⚙️ Running npm test…",
      "⌛ ⚙️ Running npm test…"
    ]);
    expect(renderAnswerTimeline([{ ...item, state: "succeeded" }], undefined, 2)[0]).toMatchObject({
      header: { title: { content: "⚙️ Ran npm test" } }
    });
  });

  it("renders bounded, redacted command and result detail", () => {
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:command", sequence: 1, category: "command", label: "run tests",
      command: "curl -H 'Authorization: Bearer live-token' https://example.invalid",
      resultPreview: `API_KEY=live-secret\n${"output\n".repeat(2_000)}`, state: "failed"
    }]);
    const serialized = JSON.stringify(panel);

    expect(serialized).toContain("**Command**");
    expect(serialized).toContain("```text");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("… +1995 lines omitted");
    expect(serialized).not.toContain("live-token");
    expect(serialized).not.toContain("live-secret");
    expect(serialized.length).toBeLessThan(6_000);
  });

  it("preserves Markdown commands inside the collapsible Tool panel", () => {
    const command = [
      "### Verify release",
      "",
      "- Run `npm test`",
      "- Keep **Markdown** formatting",
      "",
      "```bash",
      "npm run build",
      "```"
    ].join("\n");
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:markdown", sequence: 1, category: "step", label: "Release checks",
      command, state: "succeeded"
    }]);

    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(JSON.stringify(panel)).toContain("**Command**\\n\\n```bash\\n### Verify release");
    expect(JSON.stringify(panel)).toContain("- Run `npm test`");
    expect(JSON.stringify(panel)).toContain("- Keep **Markdown** formatting");
    expect(JSON.stringify(panel)).toContain("'''bash\\nnpm run build\\n'''\\n```");
  });

  it("normalizes Agent Markdown and degrades unknown work to a generic step", () => {
    const elements = renderAnswerTimeline([
      { kind: "agent_message", id: "message:safe", sequence: 1, markdown: "safe\u001b[31m red<script>hidden()</script> token=live-secret" },
      { kind: "tool", id: "tool:generic", sequence: 2, category: "tool", label: "plugin action", context: "Validate rendering", state: "running" }
    ]);
    const serialized = JSON.stringify(elements);

    expect(serialized).toContain("safe red");
    expect(serialized).toContain("🔧 Tool");
    expect(serialized).toContain("Validate rendering");
    expect(serialized).not.toContain("hidden()");
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("\u001b");
  });

  it("renders status and final answer items without reordering", () => {
    const elements = renderAnswerTimeline([
      { kind: "agent_message", id: "message:first", sequence: 1, markdown: "Checking." },
      { kind: "status", id: "status:blocked", sequence: 2, label: "Needs local approval", state: "blocked" },
      { kind: "final_answer", id: "final:one", sequence: 3, markdown: "Completed safely." }
    ]);

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(JSON.stringify(elements[1])).toContain("⚠️ 等待用户处理");
    expect(elements[2]).toMatchObject({ content: "Completed safely." });
  });

  it.each([
    ["running", "⏳ Agent running", "blue"],
    ["completed", "✅ Agent completed", "green"],
    ["blocked", "⚠️ Agent waiting", "orange"],
    ["interrupted", "⏹️ Agent interrupted", "grey"],
    ["failed", "❌ Agent failed", "red"]
  ] as const)("renders Agent %s lifecycle without collapsing blocked into failure", (state, heading, color) => {
    const [panel] = renderAnswerTimeline([
      { kind: "status", id: "agent:reviewer", sequence: 1, label: "Agent · reviewer", state }
    ]);

    expect(panel).toMatchObject({
      tag: "collapsible_panel", expanded: false, border: { color },
      header: { title: { content: `${heading} · Agent · reviewer` } }
    });
  });

  it.each([
    ["cancelled", "⏹️ 已取消", "grey"],
    ["warning", "⚠️ 数据完整性提示", "orange"]
  ] as const)("renders the %s status branch directly", (state, heading, color) => {
    const [panel] = renderAnswerTimeline([
      { kind: "status", id: `status:${state}`, sequence: 1, label: "Core status", state }
    ]);

    expect(panel).toMatchObject({
      tag: "collapsible_panel", expanded: false, border: { color },
      header: { title: { content: `${heading} · Core status` } }
    });
  });

  it("renders thinking headings with a collapsible detail body", () => {
    const elements = renderAnswerTimeline([
      { kind: "thinking", id: "thinking:one", sequence: 1, label: "Inspecting timeline alignment" }
    ]);

    expect(elements).toEqual([{ tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" }, header: { title: { tag: "plain_text", content: "💭 思考 · Inspecting timeline alignment" } }, elements: [{ tag: "markdown", content: "Inspecting timeline alignment" }] }]);
  });

  it("keeps complete normalized Thinking through the stable display budget", () => {
    const markdown = `Start\n${"complete-thinking\n".repeat(320)}End`;
    const normalized = `Start ${"complete-thinking ".repeat(320)}End`;
    const [panel] = renderAnswerTimeline([
      { kind: "thinking", id: "thinking:complete", sequence: 1, label: "Complete reasoning", markdown }
    ]);
    expect(panel).toMatchObject({
      tag: "collapsible_panel", expanded: false,
      elements: [{ content: normalized }]
    });
  });

  it("keeps stable Thinking head and tail with exact omission counts after redaction", () => {
    const middle = Array.from({ length: 20 }, (_, index) => `middle-${index}`).join("\n");
    const markdown = `${"H".repeat(3_000)}${middle}${"T".repeat(3_000)}`;
    const [panel] = renderAnswerTimeline([
      { kind: "thinking", id: "thinking:bounded", sequence: 1, label: "Bounded reasoning", markdown }
    ]);
    const detail = panel?.tag === "collapsible_panel" ? panel.elements[0]?.content ?? "" : "";
    expect(detail).toContain("H".repeat(3_000));
    expect(detail).toContain("T".repeat(3_000));
    expect(detail).toContain(`已省略中间 1 行 / ${middle.length} 个字符`);

    const [redactedPanel] = renderAnswerTimeline([
      { kind: "thinking", id: "thinking:redacted", sequence: 1, label: "Secret reasoning", markdown: `API_KEY=live-secret\n${"x".repeat(7_000)}` }
    ]);
    expect(JSON.stringify(redactedPanel)).toContain("[REDACTED]");
    expect(JSON.stringify(redactedPanel)).not.toContain("live-secret");
  });

  it("groups explicit nested tools and suppresses only byte-contained child output", () => {
    const elements = renderAnswerTimeline([
      { kind: "tool", id: "tool:outer", sequence: 1, category: "step", label: "code mode", result: "first output\nsecond output", state: "succeeded" },
      { kind: "tool", id: "tool:child-1", parentToolId: "tool:outer", sequence: 2, category: "search", label: "query", result: "first output", state: "succeeded" },
      { kind: "tool", id: "tool:child-2", parentToolId: "tool:outer", sequence: 3, category: "command", label: "build", command: "npm run build", result: "unique child output", state: "succeeded" }
    ]);
    const serialized = JSON.stringify(elements);
    expect(serialized).toContain("🛠️ Step · code mode · 2 operations · ✓ 完成");
    expect(serialized).toContain("↳ Searched for query");
    expect(serialized).toContain("↳ Ran npm run build");
    expect(serialized.match(/first output/g)).toHaveLength(1);
    expect(serialized).toContain("unique child output");
  });

  it("renders a Search and Read group as one Herdr-style collapsible summary", () => {
    const elements = renderAnswerTimeline([
      { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "running" },
      { kind: "tool", id: "tool:search", parentToolId: "tool:exec", sequence: 2, category: "search", label: '"releaseUndispatchedPromptClaim" in sqlite', state: "running" },
      { kind: "tool", id: "tool:read-1", parentToolId: "tool:exec", sequence: 3, category: "read", label: "src/store/sqlite/prompt-recovery-store.ts (1-240)", state: "running" },
      { kind: "tool", id: "tool:read-2", parentToolId: "tool:exec", sequence: 4, category: "read", label: "src/coordinator/prompt-turn-executor.ts (1-220)", state: "running" }
    ]);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { content: '🔍 Searching for "releaseUndispatchedPromptClaim" in sqlite, reading 2 files…' } }
    });
    const detail = elements[0]?.tag === "collapsible_panel" ? elements[0].elements[0]?.content ?? "" : "";
    expect(detail).toContain('Search "releaseUndispatchedPromptClaim" in sqlite');
    expect(detail).toContain("Read src/store/sqlite/prompt-recovery-store.ts (1-240)");
    expect(detail).toContain("Read src/coordinator/prompt-turn-executor.ts (1-220)");
    expect(detail).not.toContain("Tool · exec");
  });

  it("keeps an Edit command as Markdown inside its compact group", () => {
    const [panel] = renderAnswerTimeline([
      { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" },
      { kind: "tool", id: "tool:edit", parentToolId: "tool:exec", sequence: 2, category: "edit", label: "src/runtime/herdr-events-reader.ts (+9 -52)", command: "apply_patch\n- old\n+ new", state: "succeeded" }
    ]);

    expect(panel).toMatchObject({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { content: "✏️ Edited src/runtime/herdr-events-reader.ts (+9 -52)" } }
    });
    expect(JSON.stringify(panel)).toContain("**Command**\\n\\n```bash\\napply_patch\\n- old\\n+ new\\n```");
  });

  it("renders an Edit diff in its own bounded, fence-safe section", () => {
    const diff = [
      "*** Update File: src/main.ts",
      "@@",
      "-const oldValue = true;",
      "+const newValue = true;",
      "+```untrusted",
      ...Array.from({ length: 2_000 }, (_, index) => `+line-${index}`)
    ].join("\n");
    const [panel] = renderAnswerTimeline([{
      kind: "tool", id: "tool:edit-diff", sequence: 1, category: "edit",
      label: "src/main.ts (+2002 -1)", diff, state: "succeeded"
    }]);
    const serialized = JSON.stringify(panel);

    expect(panel).toMatchObject({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { content: "✏️ Edited src/main.ts (+2002 -1)" } }
    });
    expect(serialized).toContain("**Diff**\\n\\n```diff\\n*** Update File: src/main.ts");
    expect(serialized).toContain("+'''untrusted");
    expect(serialized).toContain("内容已截断，请在对应 Herdr Pane 查看完整内容。");
    expect(serialized.length).toBeLessThan(6_000);
  });

  it("renders a nested Edit diff through the shared group renderer", () => {
    const [panel] = renderAnswerTimeline([
      { kind: "tool", id: "tool:exec-diff", sequence: 1, category: "tool", label: "exec", state: "succeeded" },
      {
        kind: "tool", id: "tool:nested-edit-diff", parentToolId: "tool:exec-diff", sequence: 2,
        category: "edit", label: "src/main.ts (+1 -1)",
        diff: "*** Update File: src/main.ts\n@@\n-old\n+new", state: "succeeded"
      }
    ]);

    expect(JSON.stringify(panel)).toContain("**Diff**\\n\\n```diff\\n*** Update File: src/main.ts\\n@@\\n-old\\n+new\\n```");
  });

  it("renders a nested Command as one Ran summary with folded Markdown detail", () => {
    const [panel] = renderAnswerTimeline([
      { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" },
      { kind: "tool", id: "tool:command", parentToolId: "tool:exec", sequence: 2, category: "command", label: "npm run typecheck", command: "npm run typecheck", result: "clean", state: "succeeded" }
    ]);

    expect(panel).toMatchObject({
      tag: "collapsible_panel", expanded: false,
      header: { title: { content: "⚙️ Ran npm run typecheck" } }
    });
    const serialized = JSON.stringify(panel);
    expect(serialized).toContain("**Command**\\n\\n```bash\\nnpm run typecheck\\n```");
    expect(serialized).toContain("**Result**\\n\\n```text\\nclean\\n```");
  });

  it("expands a failed parent Tool group while retaining its failure state", () => {
    const [parent] = renderAnswerTimeline([
      { kind: "tool", id: "tool:outer", sequence: 1, category: "step", label: "code mode", state: "succeeded" },
      { kind: "tool", id: "tool:child", parentToolId: "tool:outer", sequence: 2, category: "command", label: "build", state: "failed" }
    ]);
    expect(parent).toMatchObject({ tag: "collapsible_panel", expanded: true, border: { color: "red" } });
    expect(JSON.stringify(parent)).toContain("⚙️ Failed build");
  });

  it("keeps every complete intermediate message and the full final answer", () => {
    const items: AnswerTimelineItem[] = [
      ...Array.from({ length: 5 }, (_, index): AnswerTimelineItem => ({ kind: "agent_message", id: `message:${index}`, sequence: index + 1, markdown: `message-${index}\nline-2\nline-3\nline-4` })),
      { kind: "final_answer", id: "final:one", sequence: 6, markdown: "final\nanswer\nremains\ncomplete" }
    ];
    const elements = renderAnswerTimeline(items);
    const serialized = JSON.stringify(elements);
    expect(elements).toHaveLength(6);
    expect(elements[0]).toMatchObject({ content: "🤖message-0 line-2 line-3 line-4" });
    expect(serialized).toContain("message-1");
    expect(serialized).toContain("message-2");
    expect(serialized).toContain("message-4");
    expect(elements.at(-1)).toMatchObject({ content: "final answer remains complete" });
    expect(serialized).not.toContain("lines omitted");
  });

  it.each(["running", "succeeded", "failed"] as const)("shows a head-and-tail %s Tool result with an exact omitted count", (state) => {
    const result = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\r\n");
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:result", sequence: 1, category: "command", label: "run", result, state }]);
    const serialized = JSON.stringify(panel);
    expect(serialized).toContain("line-3");
    expect(serialized).not.toContain("line-4");
    expect(serialized).not.toContain("line-11");
    expect(serialized).toContain("line-12");
    expect(serialized).toContain("line-14");
    expect(serialized).toContain("… +8 lines omitted");
  });

  it("removes the standard execution wrapper before compacting actual output", () => {
    const output = Array.from({ length: 8 }, (_, index) => `output-${index + 1}`).join("\n");
    const result = `Script completed\nWall time 0.4 seconds\nOutput:\n${output}`;
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:wrapped", sequence: 1, category: "command", label: "run", result, state: "succeeded" }]);
    const serialized = JSON.stringify(panel);

    expect(serialized).not.toContain("Script completed");
    expect(serialized).not.toContain("Wall time 0.4 seconds");
    expect(serialized).not.toContain("Output:");
    expect(serialized).toContain("output-1");
    expect(serialized).toContain("output-3");
    expect(serialized).toContain("… +2 lines omitted");
    expect(serialized).toContain("output-6");
    expect(serialized).toContain("output-8");
  });

  it("preserves malformed execution wrappers and does not overlap short output", () => {
    const malformed = "Script completed\nDuration 0.4 seconds\nOutput:\nactual output";
    const [malformedPanel] = renderAnswerTimeline([{ kind: "tool", id: "tool:malformed", sequence: 1, category: "command", label: "run", result: malformed, state: "succeeded" }]);
    const sixLines = Array.from({ length: 6 }, (_, index) => `short-${index + 1}`).join("\n");
    const [shortPanel] = renderAnswerTimeline([{ kind: "tool", id: "tool:short", sequence: 1, category: "command", label: "run", result: sixLines, state: "succeeded" }]);
    const shortSerialized = JSON.stringify(shortPanel);

    expect(malformedPanel).toMatchObject({ elements: [{ content: expect.stringContaining(malformed) }] });
    expect(shortSerialized).not.toContain("lines omitted");
    for (let index = 1; index <= 6; index += 1) expect(shortSerialized.match(new RegExp(`short-${index}`, "g"))).toHaveLength(1);
  });

  it("keeps an empty successful command as one compact Ran row", () => {
    const [element] = renderAnswerTimeline([{
      kind: "tool", id: "tool:empty", sequence: 1, category: "command", label: "run",
      result: "Script completed\nWall time 0.1 seconds\nOutput:", state: "succeeded"
    }]);
    expect(element).toEqual({ tag: "markdown", content: "⚙️ Ran run" });
  });

  it("bounds a single Tool result line and reports omitted characters", () => {
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:result", sequence: 1, category: "command", label: "run", result: "x".repeat(700), state: "succeeded" }]);
    const serialized = JSON.stringify(panel);
    expect(serialized).toContain("… +200 chars omitted");
    expect(serialized).not.toContain("x".repeat(501));
  });

  it("shows Skill identity and state without its output", () => {
    const elements = renderAnswerTimeline([{ kind: "tool", id: "tool:skill", sequence: 1, category: "skill", label: "herdr", result: "secret skill document", state: "succeeded" }]);
    const serialized = JSON.stringify(elements);
    expect(elements).toEqual([{ tag: "markdown", content: "🧩 Loaded skill herdr" }]);
    expect(serialized).not.toContain("secret skill document");
  });

  it("trims only outer blank Tool lines before head-and-tail compaction", () => {
    const result = `\n\nfirst\nsecond\n\nfourth\nfifth\nsixth\nseventh\n\n`;
    const [panel] = renderAnswerTimeline([{ kind: "tool", id: "tool:blank", sequence: 1, category: "command", label: "run", result, state: "succeeded" }]);
    expect(panel).toMatchObject({ elements: [{ content: "**Result**\n\n```text\nfirst\nsecond\n\n… +1 lines omitted\nfifth\nsixth\nseventh\n```" }] });
    expect(JSON.stringify(panel)).not.toContain("```text\n\n");
  });
});
