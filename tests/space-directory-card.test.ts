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

  it("renders a row-aligned table with short pane ids and full action payloads", () => {
    const cards = renderSpaceDirectoryCards([{ spaceName: "datasage", workspaceId: "w5", directories: ["/work/datasage"], panes: [
      { paneId: "w5:p20", name: "Working pane", agentState: "working", foregroundExecutables: ["traex"], bindingId: "binding-20" },
      { paneId: "w5:p21", name: "Free pane", agentState: "idle", foregroundExecutables: ["traex"], claimProjectId: "datasage" },
      { paneId: "w5:p22", name: "Shell", agentState: "idle", foregroundExecutables: ["bash"] }
    ] }]);
    const elements = bodyElements(cards[0]!);
    const rows = elements.filter((element) => element.tag === "column_set");

    expect(JSON.stringify(cards)).not.toContain("`w5`");
    expect(rows).toHaveLength(4);
    expect(columnText(rows[0]!)).toEqual(["**Pane**", "**状态**", "**前台进程**", "**话题**"]);
    expect(columnText(rows[1]!)).toEqual(expect.arrayContaining([expect.stringContaining("p21"), "idle", "traex", "认领"]));
    expect(columnText(rows[2]!)).toEqual(expect.arrayContaining([expect.stringContaining("p22"), "idle", "bash", "—"]));
    expect(columnText(rows[3]!)).toEqual(expect.arrayContaining([expect.stringContaining("p20"), "working", "traex", "打开话题"]));
    expect(JSON.stringify(rows[3])).toContain('"bindingId":"binding-20"');
    expect(JSON.stringify(rows[1])).toContain('"paneId":"w5:p21"');
  });

  it("splits large groups without dropping panes", () => {
    const panes = Array.from({ length: 120 }, (_, index) => ({
      paneId: `w1:p${index}`, name: `pane-${String(index).padStart(3, "0")}-${"x".repeat(100)}`, agentState: "idle" as const, foregroundExecutables: ["shell"]
    }));
    const cards = renderSpaceDirectoryCards([{ spaceName: "large", workspaceId: "w1", directories: ["/work/large"], panes }]);
    const serialized = JSON.stringify(cards);
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) expect(JSON.stringify(card).length).toBeLessThanOrEqual(12_500);
    for (const pane of panes) expect(serialized).toContain(`\`p${pane.paneId.split(":p")[1]}\``);
  });

  it("bounds a group's directory list without exceeding the card budget", () => {
    const directories = Array.from({ length: 500 }, (_, index) => `/work/${index}/${"x".repeat(200)}`);
    const cards = renderSpaceDirectoryCards([{ spaceName: "large", workspaceId: "w1", directories, panes: [] }]);
    expect(cards.every((card) => JSON.stringify(card).length <= 12_000)).toBe(true);
    expect(JSON.stringify(cards)).toContain("另 492 个");
    expect(directories).toHaveLength(500);
  });

  it("renders only open and claim actions and never a close action", () => {
    const cards = renderSpaceDirectoryCards([{ spaceName: "alpha", workspaceId: "w1", directories: ["/work/a"], panes: [
      { paneId: "w1:p1", name: "Bound", agentState: "idle", foregroundExecutables: ["traex"], bindingId: "b1" },
      { paneId: "w1:p2", name: "Free", agentState: "idle", foregroundExecutables: ["traex"], claimProjectId: "alpha" }
    ] }]);
    const serialized = JSON.stringify(cards);
    expect(serialized).toContain("open_project_thread");
    expect(serialized).toContain("claim_pane");
    expect(serialized).not.toContain("close");
  });
});

type CardElement = { tag?: string; content?: string; text?: { content?: string }; columns?: Array<{ elements?: CardElement[] }> };

function bodyElements(card: object): CardElement[] {
  return (card as { body: { elements: CardElement[] } }).body.elements;
}

function columnText(row: CardElement): string[] {
  return (row.columns ?? []).map((column) => {
    const element = column.elements?.[0];
    return element?.text?.content ?? element?.content ?? "";
  });
}
