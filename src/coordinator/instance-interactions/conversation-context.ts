import type { AgentInstance } from "../../domain/agent-instance.js";
import type { InstanceStore } from "../../domain/ports/instance.js";
import type { IncomingLarkMessage } from "../../domain/types.js";
import type { InstanceControlWorkflow } from "../instance-control-workflow.js";

export interface ConversationContext { bindingPresent: boolean; boundProjectId: string | null; conversationKey: string }

export class InstanceConversationContext {
  constructor(private readonly store: InstanceStore, private readonly control: InstanceControlWorkflow) {}

  resolve(message: IncomingLarkMessage): ConversationContext {
    const binding = this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (binding) return { bindingPresent: true, boundProjectId: binding.projectId, conversationKey: `binding:${binding.id}` };
    if (message.topicId) return { bindingPresent: false, boundProjectId: null, conversationKey: `topic:${message.topicId}` };
    if (message.rootMessageId) return { bindingPresent: false, boundProjectId: null, conversationKey: `root:${message.rootMessageId}` };
    return { bindingPresent: false, boundProjectId: null, conversationKey: message.chatId };
  }

  selected(context: ConversationContext, chatId: string): ReturnType<InstanceStore["getConversationTarget"]> {
    return this.store.getConversationTarget(context.conversationKey) ?? (!context.bindingPresent && context.conversationKey !== chatId ? this.store.getConversationTarget(chatId) : null);
  }

  boundProject(conversationKey: string, chatId: string): string | "invalid" | null {
    if (!conversationKey.startsWith("binding:")) return null;
    const binding = this.store.getBinding(conversationKey.slice("binding:".length));
    return !binding || binding.chatId !== chatId || !binding.projectId ? "invalid" : binding.projectId;
  }

  isCurrentBindingCard(value: Record<string, unknown>, conversationKey: string, chatId: string): boolean {
    const binding = this.store.getBinding(conversationKey.slice("binding:".length));
    return Boolean(binding && binding.chatId === chatId && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && value.bindingId === binding.id && Number(value.bindingGeneration) === binding.generation);
  }

  workers(conversationKey: string): AgentInstance[] {
    if (!conversationKey.startsWith("binding:")) return [];
    const binding = this.store.getBinding(conversationKey.slice("binding:".length));
    if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") return [];
    return this.control.listWorkersForParent({ bindingId: binding.id, paneId: binding.paneId });
  }

  contains(instance: AgentInstance, conversationKey: string): boolean { return this.workers(conversationKey).some(({ id }) => id === instance.id); }
  findByName(conversationKey: string, name: string): AgentInstance | null { return this.workers(conversationKey).find((item) => item.name === name) ?? null; }
}
