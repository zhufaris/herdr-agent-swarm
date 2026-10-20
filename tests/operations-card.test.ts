import { describe, expect, it } from "vitest";
import { renderFailureCards, renderSemanticDeliveryRolloutCard, renderSessionCards } from "../src/cards/operations-card.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { MAX_CARD_SERIALIZED_LENGTH } from "../src/cards/card-payload.js";

describe("operations cards", () => {
  it("presents bounded rollout refusal and version diagnostics", () => {
    const store = new SqliteBindingStore(":memory:");
    const summary = store.getOperationalSummary().semanticDeliveryRollout;
    const card = renderSemanticDeliveryRolloutCard({ ...summary, phase:"shadow", shadowMatches:7, shadowMismatches:1,
      cutoverAllowed:false, contractionAllowed:false, unsupportedVersions:2,
      ambiguousActionableRows:11,unresolvedSettlementGaps:12,retentionBlockers:13,
      shadowEpoch:4,shadowStartedAt:"2026-10-10T00:00:00.000Z",oldestUnpreparedSemanticAgeSeconds:61,preparationCasFailures:3,
      unmetPrerequisiteCount:2,oldestUnmetPrerequisiteAgeSeconds:3_601,checkpointBackwardRebases:5,
      versions:[{ snapshotSchemaVersion:2,plannerPolicyVersion:1,rendererPolicyVersion:1,gatewayProfileVersion:1,rows:2,supported:false }],
      blockers:Array.from({ length:20 },(_,index)=>`blocker-${index}`) as never });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("cutover 拒绝");
    expect(serialized).toContain("snapshot=2");
    expect(serialized).toContain("epoch 4");
    expect(serialized).toContain("CAS failures 3");
    expect(serialized).toContain("lag 2");
    expect(serialized).toContain("backward rebases 5");
    expect(serialized).toContain("ambiguous 11");
    expect(serialized).toContain("settlement gaps 12");
    expect(serialized).toContain("retention 13");
    expect(serialized).not.toContain("blocker-19");
    expect(serialized.length).toBeLessThan(12_000);
    store.close();
  });
  it("shows topic navigation for sessions", () => {
    const serialized = JSON.stringify(renderSessionCards([{ queueDepth: 2, binding: binding() }]));
    expect(serialized).toContain("Herdr Sessions");
    expect(serialized).toContain("open_project_thread");
    expect(serialized).toContain("发送话题入口");
    expect(serialized).toContain("活跃 · 已连接 · 空闲");
    expect(serialized).toContain("队列 2");
    expect(serialized).not.toContain("active/attached");
  });

  it("shows the opaque continuation command on a bounded session page", () => {
    expect(JSON.stringify(renderSessionCards([bindingSummary()], 12_000, "next_cursor"))).toContain("/swarm sessions next_cursor");
  });

  it("only gives outbound failures retry and dismiss controls", () => {
    const serialized = JSON.stringify(renderFailureCards([
      { kind: "outbound", id: "outbound-reply-123456789", bindingId: "b1", attemptCount: 5, retryAllowed: true, updatedAt: "now", error: "send", spaceName: "datasage", paneId: "w1:p1" },
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

  it("keeps large session and failure pages within the CardKit payload limit", () => {
    const sessions = Array.from({ length: 20 }, (_, index) => ({
      queueDepth: index,
      spaceName: `space-${"s".repeat(500)}-${index}`,
      binding: { ...binding(), id: `binding-${index}`, title: `session-${"t".repeat(500)}-${index}`, paneId: `pane-${"p".repeat(500)}-${index}` }
    }));
    const failures = Array.from({ length: 20 }, (_, index) => ({
      kind: "outbound" as const, id: `outbound-${index}`, bindingId: `binding-${index}`, attemptCount: 5, retryAllowed: true, updatedAt: "now",
      error: `error-${"e".repeat(500)}-${index}`, title: `title-${"t".repeat(500)}-${index}`,
      spaceName: `space-${"s".repeat(500)}-${index}`, paneId: `pane-${"p".repeat(500)}-${index}`
    }));

    for (const card of [...renderSessionCards(sessions), ...renderFailureCards(failures)]) {
      expect(JSON.stringify(card).length).toBeLessThanOrEqual(MAX_CARD_SERIALIZED_LENGTH);
    }
    expect(renderSessionCards(sessions).length).toBeGreaterThan(1);
    expect(renderFailureCards(failures).length).toBeGreaterThan(1);
  });
});

function binding() {
  return { id: "b1", projectId: "project", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", paneId: "w1:p1", traexSessionId: null, title: "Session", runtime: "traex" as const, state: "active" as const, statusMessageId: "m1", lastAgentState: "idle" as const, lastOutputFingerprint: null, lifecycle: "active" as const, attachment: "attached" as const, generation: 1, provisioningCheckpoint: "activated" as const, degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: "now", createdAt: "now", updatedAt: "now" };
}
function bindingSummary() { return { queueDepth: 0, binding: binding() }; }
