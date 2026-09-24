import { describe, expect, it } from "vitest";
import { planAnswerTimelinePage } from "../src/cards/answer-timeline-page.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

describe("answer timeline page planner", () => {
  it("keeps Tool items whole across pages", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "agent_message", id: "message:one", sequence: 1, markdown: "a".repeat(2_000) },
      { kind: "tool", id: "tool:one", sequence: 2, category: "command", label: "npm test", command: "npm test", resultPreview: "result".repeat(300), state: "succeeded" },
      { kind: "final_answer", id: "final:one", sequence: 3, markdown: "done" }
    ];

    const first = planAnswerTimelinePage(items, null, 3_200);
    const second = planAnswerTimelinePage(items, first.nextCursor, 3_200);

    expect(first.projectedItemIds).toEqual(["message:one"]);
    expect(JSON.stringify(first.elements)).not.toContain("npm test");
    expect(second.projectedItemIds).toContain("tool:one");
    expect(second.elements.some((element) => element.tag === "collapsible_panel")).toBe(true);
  });

  it("splits oversized Agent Markdown at a render-safe cursor", () => {
    const items: AnswerTimelineItem[] = [{ kind: "agent_message", id: "message:long", sequence: 1, markdown: `intro\n\n\`\`\`ts\n${"const value = 1;\n".repeat(500)}\`\`\`\n\noutro` }];
    const first = planAnswerTimelinePage(items, null, 2_000);
    const second = planAnswerTimelinePage(items, first.nextCursor, 2_000);

    expect(first.nextCursor).toMatchObject({ itemIndex: 0, markdownOffset: expect.any(Number) });
    expect(JSON.stringify(first.elements).match(/```/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(second.projectedItemIds).toContain("message:long");
    expect(second.nextCursor?.markdownOffset ?? Number.MAX_SAFE_INTEGER).toBeGreaterThan(first.nextCursor!.markdownOffset);
  });

  it("defensively truncates an oversized Tool detail instead of splitting the panel", () => {
    const item: AnswerTimelineItem = { kind: "tool", id: "tool:huge", sequence: 1, category: "command", label: "large command", command: "npm test", resultPreview: "line\n".repeat(10_000), state: "failed" };
    const page = planAnswerTimelinePage([item], null, 2_400);
    const serialized = JSON.stringify(page.elements);

    expect(page.projectedItemIds).toEqual(["tool:huge"]);
    expect(page.nextCursor).toBeNull();
    expect(page.elements).toHaveLength(1);
    expect(page.elements[0]).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(serialized).toContain("请在对应 Herdr Pane 查看完整内容");
    expect(serialized.length).toBeLessThanOrEqual(2_400);
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

  it("does not lose Agent Markdown between the page planner and renderer", () => {
    const markdown = Array.from({ length: 600 }, (_, index) => `line-${index}`).join("\n");
    const page = planAnswerTimelinePage([{ kind: "agent_message", id: "message:all", sequence: 1, markdown }], null, 9_000);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([{ kind: "agent_message", id: "message:all", sequence: 1, markdown }]);
    expect(page.elements).toEqual([{ tag: "markdown", content: markdown }]);
  });
});
