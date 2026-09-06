import { decodeDeliveryIntent } from "../domain/delivery-intent.js";
import type { OutboundReply } from "../domain/types.js";

export function materializeOutboundReply(reply: OutboundReply): string {
  const intent = decodeDeliveryIntent(reply.intentJson);
  if (!intent) return reply.payload;
  if (reply.rendererRevision !== 1 || intent.kind !== reply.intentKind) throw new Error(`Unsupported durable delivery intent for reply ${reply.id}`);
  return intent.materializedPayload;
}
