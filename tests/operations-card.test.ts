import { describe, expect, it } from "vitest";
import { renderFailureCards, renderSessionCards } from "../src/cards/operations-card.js";

describe("operations cards", () => {
  it("shows topic navigation for sessions", () => {
    const serialized = JSON.stringify(renderSessionCards([{ queueDepth: 2, binding: binding() }]));
    expect(serialized).toContain("Herdr Sessions");
    expect(serialized).toContain("open_project_thread");
    expect(serialized).toContain("发送话题入口");
    expect(serialized).toContain("活跃 · 已连接 · 空闲");
    expect(serialized).toContain("队列 2");
    expect(serialized).not.toContain("active/attached");
  });

  it("only gives outbound failures retry and dismiss controls", () => {
    const serialized = JSON.stringify(renderFailureCards([
      { kind: "outbound", id: "outbound-reply-123456789", bindingId: "b1", attemptCount: 5, updatedAt: "now", error: "send", spaceName: "datasage", paneId: "w1:p1" },
      { kind: "prompt", id: "p1", bindingId: "b1", updatedAt: "now", error: "run" }
    ]));
    expect(serialized.match(/retry_dead_letter/g)).toHaveLength(1);
    expect(serialized.match(/dismiss_dead_letter/g)).toHaveLength(1);
    expect(serialized).toContain("不可自动重试");
    expect(serialized).toContain("发送阶段");
    expect(serialized).toContain("任务阶段");
    expect(serialized).toContain("`outbound…6789`");
    expect(serialized).toContain("datasage");
    expect(serialized).toContain("w1:p1");
    expect(serialized).toContain('"replyId":"outbound-reply-123456789"');
    expect(serialized).toContain('"type":"default"');
  });
});

function binding() {
  return { id: "b1", projectId: "project", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", paneId: "w1:p1", traexSessionId: null, title: "Session", runtime: "traex" as const, state: "active" as const, statusMessageId: "m1", lastAgentState: "idle" as const, lastOutputFingerprint: null, lifecycle: "active" as const, attachment: "attached" as const, generation: 1, provisioningCheckpoint: "activated" as const, degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: "now", createdAt: "now", updatedAt: "now" };
}
