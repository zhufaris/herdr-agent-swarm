import { describe, expect, it } from "vitest";
import { renderRunCard } from "../src/cards/run-card.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("run card", () => {
  it("renders CardKit 2.0 from a projected state", () => {
    const card = renderRunCard({ ...initialTopicView("b1"), title: "Build bridge", workspaceId: "wG", paneId: "wG:p2", phase: "blocked", agentState: "blocked", queueDepth: 2 });
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "orange" } });
    expect(JSON.stringify(card)).toContain("回到对应 Herdr pane");
  });
});
