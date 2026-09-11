import { describe, expect, it } from "vitest";
import { renderTopicPaneDirectoryCard } from "../src/cards/topic-pane-directory-card.js";

describe("topic pane directory card", () => {
  it("renders each active pane with an identity-fenced send action", () => {
    const card = renderTopicPaneDirectoryCard([{
      bindingId: "binding-1", bindingGeneration: 4, paneId: "work:p1", sourceMainMessageId: "om_main",
      title: "Build * release", spaceName: "core", agentState: "working"
    }]);

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("pane_card_send");
    expect(serialized).toContain("\"bindingGeneration\":4");
    expect(serialized).toContain("\"sourceMainMessageId\":\"om_main\"");
    expect(serialized).toContain("Build \\\\* release");
    expect(serialized).toContain("发送卡片");
  });

  it("renders an explicit empty state and bounds the directory", () => {
    expect(JSON.stringify(renderTopicPaneDirectoryCard([]))).toContain("当前群中没有可发送的 active Pane 卡片。");
    const entries = Array.from({ length: 41 }, (_, index) => ({
      bindingId: `binding-${index}`, bindingGeneration: index, paneId: `work:p${index}`, sourceMainMessageId: `om-${index}`,
      title: `Task ${index}`, spaceName: "core", agentState: "idle" as const
    }));
    const serialized = JSON.stringify(renderTopicPaneDirectoryCard(entries));
    expect((serialized.match(/pane_card_send/g) ?? [])).toHaveLength(40);
    expect(serialized).toContain("仅展示前 40 个 active Pane。");
  });
});
