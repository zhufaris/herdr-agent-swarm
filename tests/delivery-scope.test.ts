import { describe, expect, it } from "vitest";
import { deliveryScopeKey, routeDelivery } from "../src/domain/delivery-scope.js";

describe("Delivery Scope", () => {
  it("routes an exact Primary owner generation to one stable Pane scope", () => {
    const route = routeDelivery({
      kind: "primary",
      workspaceId: "workspace:one",
      paneId: "pane/one",
      bindingId: "binding one",
      bindingGeneration: 2,
      sessionEpoch: 3
    });

    expect(route).toEqual({
      scope: { kind: "pane", workspaceId: "workspace:one", paneId: "pane/one" },
      parentPaneId: null,
      ownerFence: {
        kind: "primary",
        id: "binding one",
        generation: 2,
        sessionGeneration: 3
      }
    });
    expect(deliveryScopeKey(route.scope)).toBe('["pane","workspace:one","pane/one"]');
  });

  it("routes an exact Worker runtime and parent generation to its own Pane scope", () => {
    const route = routeDelivery({
      kind: "worker",
      workspaceId: "workspace",
      paneId: "worker-pane",
      parentPaneId: "primary-pane",
      workerId: "reviewer",
      workerSessionGeneration: 4,
      runtimeGeneration: 7,
      parentBindingId: "primary",
      parentBindingGeneration: 2,
      parentSessionEpoch: 3
    });

    expect(route).toEqual({
      scope: { kind: "pane", workspaceId: "workspace", paneId: "worker-pane" },
      parentPaneId: "primary-pane",
      ownerFence: {
        kind: "worker",
        id: "reviewer",
        generation: 7,
        sessionGeneration: 4,
        parent: { id: "primary", generation: 2, sessionGeneration: 3 }
      }
    });
    expect(deliveryScopeKey(route.scope)).toBe('["pane","workspace","worker-pane"]');
  });

  it("fails closed when a claimed Pane owner is not fully fenced", () => {
    expect(routeDelivery({
      kind: "primary",
      workspaceId: "workspace",
      paneId: "pane",
      bindingId: "binding",
      bindingGeneration: null,
      sessionEpoch: 1
    })).toEqual({ scope: null, ownerFence: null, parentPaneId: null });

    expect(routeDelivery({
      kind: "worker",
      workspaceId: "workspace",
      paneId: null,
      parentPaneId: "pane",
      workerId: "worker",
      workerSessionGeneration: 1,
      runtimeGeneration: 1,
      parentBindingId: "binding",
      parentBindingGeneration: 1,
      parentSessionEpoch: null
    })).toEqual({ scope: null, ownerFence: null, parentPaneId: null });
    expect(deliveryScopeKey({ kind: "global" })).toBe('["global"]');
  });

  it("does not create a Pane scope from an empty owner identity", () => {
    expect(routeDelivery({
      kind: "primary",
      workspaceId: "workspace",
      paneId: "pane",
      bindingId: "",
      bindingGeneration: 1,
      sessionEpoch: 1
    })).toEqual({ scope: null, ownerFence: null, parentPaneId: null });
  });

  it("keeps clear generations in one Pane Ring and changes Ring only with the Pane", () => {
    const before = routeDelivery({ kind: "primary", workspaceId: "workspace", paneId: "pane", bindingId: "before", bindingGeneration: 1, sessionEpoch: 1 });
    const afterClear = routeDelivery({ kind: "primary", workspaceId: "workspace", paneId: "pane", bindingId: "after", bindingGeneration: 2, sessionEpoch: 2 });
    const newPane = routeDelivery({ kind: "primary", workspaceId: "workspace", paneId: "pane-new", bindingId: "after", bindingGeneration: 2, sessionEpoch: 2 });
    expect(deliveryScopeKey(before.scope)).toBe(deliveryScopeKey(afterClear.scope));
    expect(deliveryScopeKey(newPane.scope)).not.toBe(deliveryScopeKey(afterClear.scope));
    expect(before.ownerFence).not.toEqual(afterClear.ownerFence);
  });
});
