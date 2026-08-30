import { describe, expect, it } from "vitest";
import { extractHerdrEventIds } from "../src/runtime/herdr-event-ids.js";

describe("Herdr event identity extraction", () => {
  it("extracts unique workspace and pane identities from bounded nested event data", () => {
    expect(extractHerdrEventIds({ workspace_id: "w1", pane: { workspaceId: "w2", pane_id: "p2" }, items: [{ paneId: "p1" }, { paneId: "p1" }] }))
      .toEqual({ workspaceIds: ["w1", "w2"], paneIds: ["p2", "p1"] });
    expect(extractHerdrEventIds({ workspace_id: "x".repeat(257), pane_id: "y".repeat(257) }))
      .toEqual({ workspaceIds: [], paneIds: [] });
  });

  it("bounds traversal depth, collection size, and array fanout", () => {
    const workspaces = Array.from({ length: 80 }, (_, index) => ({ workspace_id: `w${index}` }));
    const panes = Array.from({ length: 140 }, (_, index) => ({ pane_id: `p${index}` }));
    expect(extractHerdrEventIds({ workspaces, panes })).toEqual({
      workspaceIds: Array.from({ length: 64 }, (_, index) => `w${index}`),
      paneIds: Array.from({ length: 100 }, (_, index) => `p${index}`)
    });
    expect(extractHerdrEventIds({ a: { b: { c: { d: { e: { f: { workspace_id: "too-deep" } } } } } } })).toEqual({ workspaceIds: [], paneIds: [] });
  });
});
