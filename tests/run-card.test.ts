import { describe, expect, it } from "vitest";
import { renderRequestRunCard, renderRunCard } from "../src/cards/run-card.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("run card", () => {
  it("renders CardKit 2.0 from a projected state", () => {
    const card = renderRunCard({ ...initialTopicView("b1"), title: "Build bridge", workspaceId: "wG", paneId: "wG:p2", phase: "blocked", agentState: "blocked", queueDepth: 2 });
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "orange" } });
    expect((card as { header: Record<string, unknown> }).header).not.toHaveProperty("ud_icon");
    expect(JSON.stringify(card)).not.toContain('"tag":"note"');
    expect(JSON.stringify(card)).toContain("回到对应 Herdr pane");
  });

  it("renders separate expanded progress and answer regions for a completed request", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", paneId: "w1:p2", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "2026-08-22T10:00:01Z", answerDelta: "partial", progressEvents: [{ key: "read:a", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:01Z" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "2026-08-22T10:00:02Z", answer: "Fixed." });
    const card = renderRequestRunCard(completed);
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "green" } });
    expect(serialized).toContain("执行进度");
    expect(serialized).toContain("已读取 src/a.ts");
    expect(serialized).toContain("回答");
    expect(serialized).toContain("Fixed.");
    expect(serialized).not.toContain("partial");
  });

  it("keeps recent progress and reports omitted older entries", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large", workspaceId: "w1", paneId: "p1", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestRunCard({ ...view, progressEvents: Array.from({ length: 90 }, (_, index) => ({ key: "read:" + index, kind: "read" as const, label: "已读取 file-" + index, state: "done" as const, occurredAt: "now" })) });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("已省略 30 条较早记录");
    expect(serialized).not.toContain("已读取 file-0\"");
    expect(serialized).toContain("已读取 file-89");
  });
});
