import type { DeliveryScope } from "./delivery-scope.js";

export type CoreLaneIdentity = Readonly<{
  sourceId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
}>;

export type ConsumerCheckpoint =
  | Readonly<{
      consumer: "core-projection";
      scope: CoreLaneIdentity;
      position: { kind: "core-cursor"; value: string };
      updatedAtMs: number;
    }>
  | Readonly<{
      consumer: "delivery-ring";
      scope: DeliveryScope;
      position: { kind: "delivery-order"; value: number };
      updatedAtMs: number;
    }>;

export type DeliveryRingCheckpoint = Extract<ConsumerCheckpoint, { consumer: "delivery-ring" }>;

export function deliveryRingCheckpoint(scope: DeliveryScope, deliveryOrder: number, updatedAtMs: number): DeliveryRingCheckpoint {
  if (!Number.isSafeInteger(deliveryOrder) || deliveryOrder < 0) throw new Error("invalid_delivery_checkpoint_order");
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) throw new Error("invalid_delivery_checkpoint_updated_at");
  if (scope.kind === "pane" && (!scope.workspaceId || !scope.paneId)) throw new Error("invalid_delivery_checkpoint_scope");
  return {
    consumer: "delivery-ring",
    scope,
    position: { kind: "delivery-order", value: deliveryOrder },
    updatedAtMs
  };
}
