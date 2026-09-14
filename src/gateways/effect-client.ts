import { randomUUID } from "node:crypto";
import type { GatewayDeliveryIntent, GatewayDeliveryPort, GatewayDeliveryPurpose, GatewayExternalRef } from "./contract/plugin.js";
import { isGatewayView, legacyGatewayView } from "./contract/view.js";

export interface GatewayEffectPort {
  createConversation(input: { conversationId: string; view: object; idempotencyKey: string; purpose: GatewayDeliveryPurpose }): Promise<{ threadId: string; rootMessageId: string }>;
  replyText(input: { rootMessageId: string; text: string; idempotencyKey: string; purpose: GatewayDeliveryPurpose }): Promise<{ messageId: string }>;
  shareConversation(input: { conversationId: string; rootMessageId?: string; messageId: string; targetConversationId: string; purpose: GatewayDeliveryPurpose }): Promise<{ messageId: string }>;
}

export class GatewayEffectClient implements GatewayEffectPort {
  constructor(private readonly delivery: GatewayDeliveryPort) {}

  async createConversation(input: { conversationId: string; view: object; idempotencyKey: string; purpose: GatewayDeliveryPurpose }): Promise<{ threadId: string; rootMessageId: string }> {
    const receipt = await this.execute({ kind: "conversation.create", ...input, view: isGatewayView(input.view) ? input.view : legacyGatewayView(input.view) });
    return { threadId: requiredRef(receipt.refs, "thread"), rootMessageId: requiredRef(receipt.refs, "message") };
  }

  async replyText(input: { rootMessageId: string; text: string; idempotencyKey: string; purpose: GatewayDeliveryPurpose }): Promise<{ messageId: string }> {
    const receipt = await this.execute({ kind: "message.reply.text", ...input });
    return { messageId: requiredRef(receipt.refs, "message") };
  }

  async shareConversation(input: { conversationId: string; rootMessageId?: string; messageId: string; targetConversationId: string; purpose: GatewayDeliveryPurpose }): Promise<{ messageId: string }> {
    const receipt = await this.execute({ kind: "conversation.share", ...input });
    return { messageId: requiredRef(receipt.refs, "message") };
  }

  private execute(intent: GatewayDeliveryIntent) {
    const plan = this.delivery.prepare(intent);
    return this.delivery.execute(plan, { attemptId: randomUUID(), leaseFencingToken: null, idempotencyKey: "idempotencyKey" in intent ? intent.idempotencyKey : randomUUID(), priorCheckpoints: [], async checkpoint() {} });
  }
}

function requiredRef(refs: readonly GatewayExternalRef[], kind: GatewayExternalRef["kind"]): string {
  const value = refs.find((ref) => ref.kind === kind)?.opaqueId;
  if (!value) throw new Error(`Gateway effect returned no ${kind} identity`);
  return value;
}
