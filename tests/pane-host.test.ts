import { describe, expect, it, vi } from "vitest";
import { HerdrPaneHost } from "../src/runtime/herdr/pane-host.js";
import type { HerdrPort } from "../src/domain/ports.js";

describe("Herdr pane host", () => {
  it("delegates generic pane lifecycle without knowing an agent protocol", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: [] };
    const port = {
      assertWorkspace: vi.fn(async () => undefined), createPane: vi.fn(async () => pane), getPane: vi.fn(async () => pane),
      listPanes: vi.fn(async () => [pane]), sendEscape: vi.fn(async () => undefined),
      movePane: vi.fn(async () => ({ previousPaneId: "w1:p1", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1" })),
      labelPane: vi.fn(async () => ({ previousPaneId: "w1:p1", paneId: "w1:p1", paneToken: "abcd", tabId: "w1:t1", workspaceId: "w1" })),
      closePane: vi.fn(async () => undefined)
    } as unknown as HerdrPort;
    const host = new HerdrPaneHost(port);

    await expect(host.ensureWorkspace("w1")).resolves.toBeUndefined();
    await expect(host.allocatePane("w1", "/repo", { bindingId: "i1", generation: 1, projectId: "p1" })).resolves.toEqual(pane);
    await expect(host.inspectPane("w1:p1")).resolves.toEqual(pane);
    await expect(host.movePane({ paneId: "w1:p1", targetTabId: "w1:t1", targetAnchorPaneId: "w1:p0", paneLabel: "abcd-worker", tabLabel: "abcd" }))
      .resolves.toMatchObject({ previousPaneId: "w1:p1", paneId: "w1:p2" });
    await expect(host.labelPane({ workspaceId: "w1", paneId: "w1:p1", paneToken: "abcd", tabId: "w1:t1", paneLabel: "abcd-worker", tabLabel: "abcd" }))
      .resolves.toMatchObject({ previousPaneId: "w1:p1", paneId: "w1:p1" });
    await host.interruptPane("w1:p1");
    await host.releasePane("w1:p1");

    expect(port.createPane).toHaveBeenCalledWith("w1", "/repo", expect.objectContaining({ bindingId: "i1" }));
    expect(port.sendEscape).toHaveBeenCalledWith("w1:p1");
    expect(port.movePane).toHaveBeenCalledWith(expect.objectContaining({ targetAnchorPaneId: "w1:p0" }));
    expect(port.labelPane).toHaveBeenCalledWith(expect.objectContaining({ paneLabel: "abcd-worker", tabLabel: "abcd" }));
    expect(port.closePane).toHaveBeenCalledWith("w1:p1");
  });
});
