import { describe, expect, it } from "vitest";
import { renderSpaceDirectoryCards } from "../src/cards/space-directory-card.js";

describe("space directory card", () => {
  it("renders empty, failed, and sorted pane groups", () => {
    const cards = renderSpaceDirectoryCards([
      { spaceName: "alpha", workspaceId: "w1", directories: ["/work/a"], panes: [
        { paneId: "w1:p2", name: "Zulu", agentState: "idle", foregroundExecutables: [] },
        { paneId: "w1:p1", name: "Alpha", agentState: "working", foregroundExecutables: ["vim"] }
      ] },
      { spaceName: "empty", workspaceId: "w2", directories: ["/work/empty"], panes: [] },
      { spaceName: "failed", workspaceId: "w3", directories: ["/work/failed"], panes: [], error: "workspace unavailable" }
    ]);
    const serialized = JSON.stringify(cards);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ header: { template: "orange" } });
    expect(serialized.indexOf("Alpha")).toBeLessThan(serialized.indexOf("Zulu"));
    expect(serialized).toContain("暂无 Pane");
    expect(serialized).toContain("workspace unavailable");
  });

  it("splits large groups without dropping panes", () => {
    const panes = Array.from({ length: 120 }, (_, index) => ({
      paneId: `w1:p${index}`, name: `pane-${String(index).padStart(3, "0")}-${"x".repeat(100)}`, agentState: "idle" as const, foregroundExecutables: ["shell"]
    }));
    const cards = renderSpaceDirectoryCards([{ spaceName: "large", workspaceId: "w1", directories: ["/work/large"], panes }]);
    const serialized = JSON.stringify(cards);
    expect(cards.length).toBeGreaterThan(1);
    for (const pane of panes) expect(serialized).toContain(pane.paneId);
  });
});
