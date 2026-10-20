import type { BindingPromptWorkflowPort } from "../domain/ports/prompt-acceptance.js";
import type { PrimaryRuntimeStatePort } from "../domain/ports/primary-runtime-state.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import type { Binding, IncomingLarkMessage, ProjectSelection } from "../domain/types.js";
import { isPromptCapacityExceeded } from "../domain/prompt-capacity-error.js";

export type PromptAdmissionResult =
  | { outcome: "accepted"; promptId: string }
  | { outcome: "capacity_deferred" };

export interface PromptAdmissionWorkflowPort {
  accept(binding: Binding, message: IncomingLarkMessage, body?: string): Promise<PromptAdmissionResult | null>;
  acceptInitial(binding: Binding, selection: ProjectSelection): Promise<PromptAdmissionResult | null>;
}

interface Options {
  bindingPrompts: BindingPromptWorkflowPort;
  routing: Pick<InboundRoutingStore, "isBindingThreadAlias">;
  primaryState: Pick<PrimaryRuntimeStatePort, "activeTurn">;
}

export class PromptAdmissionWorkflow implements PromptAdmissionWorkflowPort {
  constructor(private readonly options: Options) {}

  async acceptInitial(binding: Binding, selection: ProjectSelection): Promise<PromptAdmissionResult | null> {
    if (!selection.initialPromptText) return null;
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    return this.acceptManaged({
      binding,
      body: selection.initialPromptText,
      actorOpenId: selection.actorOpenId,
      sourceMessageKey: selection.commandMessageId,
      larkMessageId: selection.commandMessageId,
      rootMessageId: binding.rootMessageId
    });
  }

  async accept(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<PromptAdmissionResult | null> {
    const answerRootMessageId = this.options.routing.isBindingThreadAlias(message.topicId, message.rootMessageId) ? message.rootMessageId : binding.rootMessageId;
    if (!answerRootMessageId) throw new Error("This binding has no Lark root message");
    return this.acceptManaged({
      binding,
      body,
      actorOpenId: message.actorOpenId,
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      rootMessageId: answerRootMessageId
    });
  }

  private async acceptManaged(input: {
    binding: Binding;
    body: string;
    actorOpenId: string;
    sourceMessageKey: string;
    larkMessageId: string | null;
    rootMessageId: string;
  }): Promise<PromptAdmissionResult | null> {
    let receipt;
    try {
      receipt = await this.options.bindingPrompts.acceptManagedInput({
        binding: input.binding,
        body: input.body,
        actor: { openId: input.actorOpenId },
        ingressSource: "feishu",
        sourceMessageKey: input.sourceMessageKey,
        larkMessageId: input.larkMessageId,
        parentPromptId: this.options.primaryState.activeTurn(input.binding.id)?.promptId ?? null,
        priority: "normal",
        initialProjectionContext: { rootMessageId: input.rootMessageId }
      });
    } catch (error) {
      if (isPromptCapacityExceeded(error)) return { outcome: "capacity_deferred" };
      throw error;
    }
    if (!receipt) return null;
    if (receipt.result.prompt) return { outcome: "accepted", promptId: receipt.result.prompt.id };
    return { outcome: "accepted", promptId: receipt.result.batch.id };
  }
}
