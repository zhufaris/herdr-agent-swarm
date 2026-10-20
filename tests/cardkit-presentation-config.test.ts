import { describe, expect, it } from "vitest";
import { createCardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";
import { createFeishuGatewayApplicationPresentation } from "../src/gateways/feishu/presentation.js";

describe("configured CardKit presentation", () => {
  it("injects one immutable runtime identity into Turn Cards", () => {
    const presentation = createFeishuGatewayApplicationPresentation(
      { payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 },
      [],
      { branch: "main", gitCommit: "0123456789abcdef0123456789abcdef01234567" }
    );
    const view = {
      segmentId: "segment", ownerKind: "primary", ownerLabel: "Primary", spaceName: "project",
      projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "continue",
      state: "working", gapWarning: null, viewVersion: 1, timelineItems: []
    } as const;
    const planned = presentation.turnCardPage(view, { pageIndex: 0 });
    const semantic = presentation.turnCardSemanticPolicy.plan(view, { pageIndex: 0 }, {}, {
      encodedBytes: 12_000, elementCount: 100, actionCount: 10, profileVersion: 1
    });

    expect(JSON.stringify(planned.card)).not.toContain("BRANCH `main` · BUILD `0123456789ab`");
    expect(JSON.stringify(presentation.turnCardSemanticPolicy.render(semantic.snapshot))).not.toContain("BRANCH `main` · BUILD `0123456789ab`");
  });

  it("bounds Answer rendering with the configured stream safety limit", () => {
    const presentation = createCardKitApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 4_000 });
    const rendered = presentation.answerStreamPage("x".repeat(10_000), 0, 9_000);
    expect(rendered.page.length).toBeLessThanOrEqual(4_000);
    expect(rendered.nextPageStart).not.toBeNull();
  });

  it("uses the configured payload budget when paginating operation cards", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      binding: { id: `b${index}`, title: `session-${index}-${"x".repeat(400)}`, projectId: "p", workspaceId: "w", paneId: `w:p${index}`, lifecycle: "active" as const, attachment: "attached" as const, lastAgentState: "idle" as const, generation: 1, lastActivityAt: new Date().toISOString(), rootMessageId: null },
      queueDepth: 0, spaceName: "space"
    }));
    const presentation = createCardKitApplicationPresentation({ payloadLimitChars: 1_000, answerStreamLimitChars: 28_000 });
    expect(presentation.sessions({ sessions, nextCursor: null }).length).toBeGreaterThan(1);
  });

  it("renders a continuation from its canonical cursor exactly once", () => {
    const presentation = createCardKitApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
    const view = {
      segmentId: "segment", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project",
      projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "continue",
      state: "working" as const, gapWarning: null, viewVersion: 3,
      timelineItems: [
        { kind: "agent_message" as const, id: "message:first", sequence: 1, markdown: "first-page-only" },
        { kind: "tool" as const, id: "tool:wait", sequence: 2, category: "step" as const, label: "Wait · session 42", state: "running" as const },
        { kind: "status" as const, id: "status:wait", sequence: 3, label: "Waiting for command", state: "running" as const }
      ]
    };

    const planned = presentation.turnCardPage(view, {
      pageIndex: 1, elementId: "turn-card:segment:page:1", startCursor: { itemIndex: 1, markdownOffset: 0 }
    });
    const rendered = JSON.stringify(planned.card);

    expect(planned.items.map(({ id }) => id)).toEqual(["tool:wait", "status:wait"]);
    expect(rendered).not.toContain("first-page-only");
    expect(rendered).toContain("Wait · session 42");
    expect(rendered).toContain("Waiting for command");
  });
});
