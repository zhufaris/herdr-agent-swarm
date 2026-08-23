import { randomUUID } from "node:crypto";
import type { BridgeEvent } from "./events.js";
import type { EventOrigin } from "./types.js";

type BridgeEventByType = { [E in BridgeEvent as E["type"]]: E };
export type BridgeEventOf<T extends BridgeEvent["type"]> = BridgeEventByType[T];

export function createBridgeEvent<T extends keyof BridgeEventByType>(
  bindingId: string,
  type: T,
  origin: EventOrigin,
  payload: BridgeEventByType[T]["payload"]
): BridgeEventByType[T] {
  return { eventId: randomUUID(), bindingId, type, origin, occurredAt: new Date().toISOString(), payload } as BridgeEventByType[T];
}
