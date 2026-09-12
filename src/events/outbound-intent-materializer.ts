import { decodeDeliveryIntent } from "../domain/delivery-intent.js";
import type { OutboundReply } from "../domain/types.js";
import { PermanentDeliveryError } from "./outbound-target-validation.js";

export function materializeOutboundReply(reply: OutboundReply): string {
  const legacy = reply.intentKind === null && reply.intentJson === null && reply.rendererRevision === null;
  if (legacy) return reply.payload;
  const intent = decodeDeliveryIntent(reply.intentJson);
  if (!intent || reply.rendererRevision !== 1 || intent.kind !== reply.intentKind) throw new PermanentDeliveryError(`Unsupported durable delivery intent for reply ${reply.id}`);
  return intent.materializedPayload;
}
