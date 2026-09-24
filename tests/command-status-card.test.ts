import { describe, expect, it } from "vitest";
import { renderCommandStatusCard } from "../src/cards/command-status-card.js";
import { createAcceptedCommandStatusView, transitionCommandStatusView } from "../src/domain/command-status-view.js";

const input = { id: "12345678-abcd", idempotencyKey: "key", laneKey: "project:p1", command: { kind: "rename", title: "Safe title" } as const, context: { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "operator", projectId: "p1", workspaceId: "w1", primary: null }, replayPolicy: "safe-before-effect" as const, acceptedAt: "2026-09-24T00:00:00.000Z" };

describe("Command status view", () => {
  it("advances revisions monotonically and preserves a safe definition summary", () => {
    const accepted = createAcceptedCommandStatusView(input, "literal");
    const executing = transitionCommandStatusView(accepted, { state: "executing", attemptCount: 1, outcome: null, occurredAt: "2026-09-24T00:01:00.000Z" });
    const uncertain = transitionCommandStatusView(executing, { state: "uncertain", attemptCount: 1, outcome: { code: "external_effect_uncertain", detail: "token=secret-value", operationKind: null, operationId: null }, occurredAt: "2026-09-24T00:02:00.000Z" });
    expect([accepted.revision, executing.revision, uncertain.revision]).toEqual([1, 2, 3]);
    expect(accepted.summary).toBe("重命名当前话题和 Pane");
    expect(JSON.stringify(renderCommandStatusCard(uncertain))).toContain("系统不会自动重试");
    expect(JSON.stringify(renderCommandStatusCard(uncertain))).not.toContain("secret-value");
  });
});
