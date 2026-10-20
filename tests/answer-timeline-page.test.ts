import { describe, expect, it } from "vitest";
import { planAnswerTimelinePage } from "../src/cards/answer-timeline-page.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

describe("answer timeline page planner", () => {
  it("uses canonical sequence rather than lexicographic item IDs", () => {
    expect(() => planAnswerTimelinePage([
      { kind: "agent_message", id: "z-item", sequence: 2, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }, markdown: "second" },
      { kind: "agent_message", id: "a-item", sequence: 1, canonicalPosition: { laneSequence: 1, itemOrdinal: 0 }, markdown: "first" }
    ], null, 4_000)).toThrow("strictly increasing canonical order");
  });
  it("keeps compact Tool items whole on a page", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:one", sequence: 1, markdown: "a".repeat(2_000) },
      { kind: "tool", id: "tool:one", sequence: 2, category: "command", label: "npm test", command: "npm test", resultPreview: "result".repeat(300), state: "succeeded" },
      { kind: "final_answer", id: "final:one", sequence: 3, markdown: "done" }
    ];

    const first = planAnswerTimelinePage(items, null, 3_200);

    expect(first.nextCursor).toBeNull();
    expect(first.projectedItemIds).toEqual(["message:one", "tool:one", "final:one"]);
    expect(JSON.stringify(first.elements)).toContain("npm test");
    expect(first.elements.some((element) => element.tag === "collapsible_panel")).toBe(true);
  });

  it("preserves complete intermediate Agent Markdown across continuation pages", () => {
    const markdown = ["基于当前真实 timeline：", "", "| 优先级 | 优化点 |", "| --- | --- |", ...Array.from({ length: 20 }, (_, index) => `| P${index} | item-${index} |`)].join("\n");
    const items: AnswerTimelineItem[] = [{ kind: "agent_message", id: "message:long", sequence: 1, markdown }];
    const rendered: string[] = [];
    let cursor = null;
    for (let index = 0; index < 20; index += 1) {
      const page = planAnswerTimelinePage(items, cursor, 900);
      rendered.push(...page.elements.filter((element) => element.tag === "markdown").map((element) => element.content));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(rendered.join("")).toContain("🤖");
    expect(rendered.join("")).toContain("| P19 | item-19 |");
    expect(rendered.join("")).not.toContain("lines omitted");
  });

  it("renders an exact commentary and final duplicate only as the final answer", () => {
    const markdown = "same answer\nwith details";
    const page = planAnswerTimelinePage([
      { kind: "agent_message", id: "message:commentary", sequence: 1, markdown: `${markdown}\n` },
      { kind: "final_answer", id: "message:final", sequence: 2, markdown }
    ], null, 4_000);

    expect(JSON.stringify(page.elements).match(/same answer/g)).toHaveLength(1);
    expect(page.items.map(({ id }) => id)).toEqual(["message:final"]);
  });

  it("deduplicates a visible answer when commentary adds only terminal memory citation metadata", () => {
    const markdown = "same visible answer\nwith details";
    const citation = [
      "<oai-mem-citation>",
      "<citation_entries>",
      "MEMORY.md:10-12|note=[render evidence]",
      "</citation_entries>",
      "<rollout_ids>",
      "01a00000-0000-7000-8000-000000000001",
      "</rollout_ids>",
      "</oai-mem-citation>"
    ].join("\n");
    const page = planAnswerTimelinePage([
      { kind: "agent_message", id: "message:commentary", sequence: 1, markdown: `${markdown}\n\n${citation}` },
      { kind: "final_answer", id: "message:final", sequence: 2, markdown }
    ], null, 4_000);

    const rendered = JSON.stringify(page.elements);
    expect(rendered.match(/same visible answer/g)).toHaveLength(1);
    expect(rendered).not.toContain("oai-mem-citation");
    expect(page.items.map(({ id }) => id)).toEqual(["message:final"]);
  });

  it("hides terminal memory citation metadata on a final answer", () => {
    const citation = "<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>";
    const page = planAnswerTimelinePage([{ kind: "final_answer", id: "message:final", sequence: 1, markdown: `visible\n\n${citation}` }], null, 4_000);

    expect(page.elements).toEqual([{ tag: "markdown", content: "visible" }]);
    expect(page.items[0]).toMatchObject({ id: "message:final", markdown: "visible" });
  });

  it("uses presentation Markdown for a complete final envelope", () => {
    const choice = { version: 3, choice: { question: "Approve?", defaultOption: { id: "approve", label: "Approve", submitText: "Approve" }, alternatives: [] } };
    const citation = "<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>";
    const markdown = `visible\n\n<at id=ou_1234567890abcdef></at>\n\n$herdr-choice-list:herdr-choice-list\n\`\`\`herdr-choice-list\n${JSON.stringify(choice)}\n\`\`\`\n\n${citation}`;
    const page = planAnswerTimelinePage([{ kind: "final_answer", id: "message:final", sequence: 1, markdown }], null, 4_000);

    expect(page.elements).toEqual([{ tag: "markdown", content: "visible" }]);
    expect(page.items[0]).toMatchObject({ id: "message:final", markdown: "visible" });
    expect(markdown).toContain(citation);
  });

  it("keeps a malformed choice block in the timeline while hiding requester syntax, invocation, and citation", () => {
    const malformed = "```herdr-choice-list\n{not-json}\n```";
    const citation = "<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>";
    const markdown = `visible\n\n<at id=ou_1234567890abcdef></at>\n\n$herdr-choice-list:herdr-choice-list\n${malformed}\n\n${citation}`;
    const page = planAnswerTimelinePage([{ kind: "final_answer", id: "message:final", sequence: 1, markdown }], null, 4_000);

    expect(page.elements).toEqual([{ tag: "markdown", content: `visible\n\n${malformed}` }]);
    expect(page.items[0]).toMatchObject({ id: "message:final", markdown: `visible\n\n${malformed}` });
  });

  it.each([
    ["incomplete citation", "visible\n\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>", "final"],
    ["mid-body citation", "visible\n\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>\n\ncontinued", "final"],
    ["fenced literal citation", "```xml\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>\n```", "final"],
    ["unclosed tilde-fenced literal citation", "~~~xml\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>", "final"],
    ["nested citation XML", "visible\n\n<oai-mem-citation>\n<citation_entries><unexpected>entry</unexpected></citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>", "final"],
    ["closed tilde-fenced literal citation", "~~~xml\n<oai-mem-citation>\n<citation_entries>entry</citation_entries>\n<rollout_ids></rollout_ids>\n</oai-mem-citation>\n~~~~\nvisible", "final"],
  ])("keeps %s visible and distinct", (_label, commentary, suffix) => {
    const page = planAnswerTimelinePage([
      { kind: "agent_message", id: "message:commentary", sequence: 1, markdown: commentary },
      { kind: "final_answer", id: "message:final", sequence: 2, markdown: suffix }
    ], null, 4_000);

    expect(page.items.map(({ id }) => id)).toEqual(["message:commentary", "message:final"]);
    expect(JSON.stringify(page.elements)).toContain("entry");
    expect(JSON.stringify(page.elements)).toContain("final");
  });

  it("keeps similar but non-identical commentary and final answers", () => {
    const page = planAnswerTimelinePage([
      { kind: "agent_message", id: "message:commentary", sequence: 1, markdown: "partial answer" },
      { kind: "final_answer", id: "message:final", sequence: 2, markdown: "complete answer" }
    ], null, 4_000);

    expect(JSON.stringify(page.elements)).toContain("partial answer");
    expect(JSON.stringify(page.elements)).toContain("complete answer");
  });

  it("keeps a concise Tool title while retaining its command in collapsed detail", () => {
    const command = "sqlite3 -readonly /tmp/bridge.db SELECT-many-columns";
    const page = planAnswerTimelinePage([{ kind: "tool", id: "tool:query", sequence: 1, category: "command", label: "Query · bridge.db", command, state: "succeeded" }], null, 4_000);
    const panel = page.elements[0];

    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false, header: { title: { content: `⚙️ Ran ${command}` } } });
    expect(JSON.stringify(panel)).toContain(command);
  });

  it("keeps a compact semantic Tool group whole while retaining every source id", () => {
    const page = planAnswerTimelinePage([
      { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" },
      { kind: "tool", id: "tool:search", parentToolId: "tool:exec", sequence: 2, category: "search", label: '"claimPrompt" in sqlite', state: "succeeded" },
      { kind: "tool", id: "tool:read", parentToolId: "tool:exec", sequence: 3, category: "read", label: "src/store.ts (1-80)", state: "succeeded" },
      { kind: "final_answer", id: "final:one", sequence: 4, markdown: "Done." }
    ], null, 4_000);

    expect(page.elements).toHaveLength(2);
    expect(page.elements[0]).toMatchObject({ tag: "collapsible_panel", header: { title: { content: '🔍 Searched for "claimPrompt" in sqlite, read 1 file' } } });
    expect(page.projectedItemIds).toEqual(["tool:exec", "tool:search", "tool:read", "final:one"]);
    expect(page.items.map(({ id }) => id)).toEqual(["tool:exec", "tool:search", "tool:read", "final:one"]);
  });

  it("compacts oversized Tool result without creating continuation pages", () => {
    const result = Array.from({ length: 800 }, (_, index) => `line-${index}`).join("\n");
    const item: AnswerTimelineItem = { kind: "tool", id: "tool:huge", sequence: 1, category: "command", label: "large command", command: "npm test", result, state: "failed" };
    const page = planAnswerTimelinePage([item], null, 2_400);
    const serialized = JSON.stringify(page.elements);

    expect(page.nextCursor).toBeNull();
    expect(page.elements[0]).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(serialized).toContain("line-2");
    expect(serialized).not.toContain("line-3");
    expect(serialized).not.toContain("line-796");
    expect(serialized).toContain("line-797");
    expect(serialized).toContain("line-799");
    expect(serialized).toContain("… +794 lines omitted");
    expect(page.items[0]).toMatchObject({ result: expect.stringContaining("… +794 lines omitted") });
    expect(result).toContain("line-799");
  });

  it("moves one stable Thinking panel to the next page without shortening or reordering", () => {
    const thinking = `Thinking start\n${"detail-line\n".repeat(360)}Thinking end`;
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:before", sequence: 1, markdown: "before ".repeat(100) },
      { kind: "thinking", id: "thinking:stable", sequence: 2, label: "Stable reasoning", markdown: thinking },
      { kind: "final_answer", id: "final:after", sequence: 3, markdown: "after" }
    ];

    const normalizedThinking = `Thinking start ${"detail-line ".repeat(360)}Thinking end`;
    const first = planAnswerTimelinePage(items, null, 4_700);
    expect(first.projectedItemIds).toEqual(["message:before"]);
    expect(first.nextCursor).toEqual({ itemIndex: 1, markdownOffset: 0 });
    expect(JSON.stringify(first.elements)).not.toContain("Stable reasoning");

    const second = planAnswerTimelinePage(items, first.nextCursor, 4_700);
    const panel = second.elements.find((element) => element.tag === "collapsible_panel");
    expect(panel).toMatchObject({ elements: [{ content: normalizedThinking }] });
    expect(second.projectedItemIds[0]).toBe("thinking:stable");
    expect(second.projectedItemIds.filter((id) => id === "thinking:stable")).toHaveLength(1);

    const third = second.nextCursor ? planAnswerTimelinePage(items, second.nextCursor, 4_700) : second;
    expect([...second.projectedItemIds, ...(third === second ? [] : third.projectedItemIds)]).toContain("final:after");
  });

  it("keeps a Wait Tool activity and its waiting status across pagination", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:before-wait", sequence: 1, markdown: "before ".repeat(220) },
      { kind: "tool", id: "tool:wait-1", sequence: 2, category: "step", label: "Wait · session 42", state: "running" },
      { kind: "status", id: "status:wait-1", sequence: 3, label: "Waiting for command", state: "running" }
    ];
    const seen = new Set<string>();
    let cursor = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = planAnswerTimelinePage(items, cursor, 900);
      for (const id of page.projectedItemIds) seen.add(id);
      const rendered = JSON.stringify(page.elements);
      if (page.projectedItemIds.includes("tool:wait-1")) expect(rendered).toContain("Wait · session 42");
      if (page.projectedItemIds.includes("status:wait-1")) expect(rendered).toContain("Waiting for command");
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect([...seen]).toEqual(expect.arrayContaining(["tool:wait-1", "status:wait-1"]));
  });

  it("keeps an oversized command and result on one compact Tool panel", () => {
    const command = Array.from({ length: 400 }, (_, index) => `echo command-${index}`).join("\n");
    const item: AnswerTimelineItem = { kind: "tool", id: "tool:command", sequence: 1, category: "command", label: "long script", command, result: "finished", state: "succeeded" };
    const page = planAnswerTimelinePage([item], null, 2_400);
    const serialized = JSON.stringify(page.elements);
    expect(page.nextCursor).toBeNull();
    expect(page.projectedItemIds).toEqual(["tool:command"]);
    expect(serialized).toContain("echo command-0");
    expect(serialized).toContain("echo command-399");
    expect(serialized).toContain("已省略中间");
    expect(serialized).toContain("finished");
  });

  it("uses a Herdr human message as a JSONL pagination marker without rendering it", () => {
    const result = Array.from({ length: 800 }, (_, index) => `result-${index}`).join("\n");
    const items: AnswerTimelineItem[] = [
      { kind: "tool", id: "tool:verbose", sequence: 1, category: "command", label: "inspect live state", result, state: "succeeded" },
      { kind: "human_message", id: "human:local", sequence: 2, markdown: "Continue from Herdr" },
      { kind: "agent_message", id: "message:follow-up", sequence: 3, markdown: "Continuing now." }
    ];

    const page = planAnswerTimelinePage(items, null, 2_400);

    expect(page.nextCursor).toEqual({ itemIndex: 1, markdownOffset: 0 });
    expect(page.projectedItemIds).toEqual(["tool:verbose"]);
    expect(JSON.stringify(page.elements)).toContain("… +794 lines omitted");
    expect(JSON.stringify(page.elements)).not.toContain("Continue from Herdr");

    const continuation = planAnswerTimelinePage(items, page.nextCursor, 2_400);
    expect(continuation.nextCursor).toBeNull();
    expect(continuation.projectedItemIds).toEqual(["message:follow-up"]);
    expect(JSON.stringify(continuation.elements)).toContain("Continuing now.");
  });

  it("uses stable item indexes even when sequences are sparse", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:a", sequence: 10, markdown: "a".repeat(2_000) },
      { kind: "final_answer", id: "final:z", sequence: 99, markdown: "final" }
    ];
    const first = planAnswerTimelinePage(items, null, 1_400);
    let cursor = first.nextCursor;
    let last = first;
    for (let index = 0; cursor && index < 10; index += 1) { last = planAnswerTimelinePage(items, cursor, 1_400); cursor = last.nextCursor; }
    expect(cursor).toBeNull();
    expect(last.projectedItemIds).toContain("final:z");
  });

  it("does not lose final Answer Markdown between the page planner and renderer", () => {
    const markdown = Array.from({ length: 600 }, (_, index) => `line-${index}`).join("\n");
    const page = planAnswerTimelinePage([{ kind: "final_answer", id: "message:all", sequence: 1, markdown }], null, 9_000);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([{ kind: "final_answer", id: "message:all", sequence: 1, markdown }]);
    expect(page.elements).toEqual([{ tag: "markdown", content: markdown }]);
  });
});
