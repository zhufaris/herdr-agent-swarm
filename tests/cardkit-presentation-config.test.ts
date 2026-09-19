import { describe, expect, it } from "vitest";
import { createCardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";

describe("configured CardKit presentation", () => {
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
});
