export type DeliveryOwnerFence = {
  kind: "primary" | "worker";
  id: string;
  generation: number;
  sessionGeneration: number;
  parent?: { id: string; generation: number; sessionGeneration: number };
};

export type DeliveryScope =
  | { kind: "pane"; workspaceId: string; paneId: string }
  | { kind: "global" };

export interface DeliveryRoute {
  scope: DeliveryScope | null;
  ownerFence: DeliveryOwnerFence | null;
  parentPaneId: string | null;
}

export type DeliveryScopeFacts =
  | {
      kind: "primary";
      workspaceId: string | null;
      paneId: string | null;
      bindingId: string;
      bindingGeneration: number | null;
      sessionEpoch: number | null;
    }
  | {
      kind: "worker";
      workspaceId: string | null;
      paneId: string | null;
      parentPaneId: string | null;
      workerId: string;
      workerSessionGeneration: number | null;
      runtimeGeneration: number | null;
      parentBindingId: string | null;
      parentBindingGeneration: number | null;
      parentSessionEpoch: number | null;
    }
  | { kind: "unowned" };

export function routeDelivery(facts: DeliveryScopeFacts): DeliveryRoute {
  if (facts.kind === "primary") {
    if (!validText(facts.workspaceId) || !validText(facts.paneId) || !validText(facts.bindingId)
      || !validGeneration(facts.bindingGeneration) || !validGeneration(facts.sessionEpoch)) return { scope: null, ownerFence: null, parentPaneId: null };
    return {
      scope: { kind: "pane", workspaceId: facts.workspaceId, paneId: facts.paneId },
      parentPaneId: null,
      ownerFence: {
        kind: "primary",
        id: facts.bindingId,
        generation: facts.bindingGeneration,
        sessionGeneration: facts.sessionEpoch
      }
    };
  }
  if (facts.kind === "worker") {
    if (!validText(facts.workspaceId) || !validText(facts.paneId) || !validText(facts.parentPaneId)
      || !validText(facts.workerId) || !validText(facts.parentBindingId)
      || !validGeneration(facts.workerSessionGeneration)
      || !validGeneration(facts.runtimeGeneration)
      || !validGeneration(facts.parentBindingGeneration)
      || !validGeneration(facts.parentSessionEpoch)) return { scope: null, ownerFence: null, parentPaneId: null };
    return {
      scope: { kind: "pane", workspaceId: facts.workspaceId, paneId: facts.paneId },
      parentPaneId: facts.parentPaneId,
      ownerFence: {
        kind: "worker",
        id: facts.workerId,
        generation: facts.runtimeGeneration,
        sessionGeneration: facts.workerSessionGeneration,
        parent: { id: facts.parentBindingId, generation: facts.parentBindingGeneration, sessionGeneration: facts.parentSessionEpoch }
      }
    };
  }
  return { scope: { kind: "global" }, ownerFence: null, parentPaneId: null };
}

export function deliveryScopeKey(scope: DeliveryScope): string {
  if (scope.kind === "global") return JSON.stringify(["global"]);
  return JSON.stringify(["pane", scope.workspaceId, scope.paneId]);
}

function validText(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

function validGeneration(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
