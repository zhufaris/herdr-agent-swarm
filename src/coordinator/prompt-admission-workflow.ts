import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import { formatPromptTitle } from "../domain/prompt-title.js";
import type { PromptAcceptanceStore } from "../domain/ports/prompt-acceptance.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { PrimaryRuntimeStatePort } from "../domain/ports/primary-runtime-state.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, IncomingLarkMessage, ProjectSelection } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { executePromptAcceptanceEffects } from "./prompt-acceptance-effects.js";
import { ProjectCatalog } from "./project-catalog.js";

export interface PromptAdmissionWorkflowPort {
  accept(binding: Binding, message: IncomingLarkMessage, body?: string): Promise<{ promptId: string } | null>;
  acceptInitial(binding: Binding, selection: ProjectSelection): Promise<{ promptId: string } | null>;
}

interface Options {
  config: Pick<BridgeConfig, "projects" | "maxQueueDepth">;
  store: PromptAcceptanceStore;
  routing: Pick<InboundRoutingStore, "isBindingThreadAlias">;
  primaryState: Pick<PrimaryRuntimeStatePort, "activeTurn">;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  presentation: Pick<PrimaryPresentation, "answerCard" | "requestRejected">;
}

export class PromptAdmissionWorkflow implements PromptAdmissionWorkflowPort {
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
  }

  async acceptInitial(binding: Binding, selection: ProjectSelection): Promise<{ promptId: string } | null> {
    if (!selection.initialPromptText) return null;
    return this.accept(binding, {
      eventId: `project-selection:${selection.id}`, messageId: selection.commandMessageId, parentMessageId: null, chatId: selection.chatId,
      topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: selection.actorOpenId, text: selection.initialPromptText, mentionsBot: true, isRootMessage: false
    });
  }

  async accept(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<{ promptId: string } | null> {
    const answerRootMessageId = this.options.routing.isBindingThreadAlias(message.topicId, message.rootMessageId) ? message.rootMessageId : binding.rootMessageId;
    if (!answerRootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID();
    const acceptedAt = new Date().toISOString();
    const capturedParentPromptId = this.options.primaryState.activeTurn(binding.id)?.promptId ?? null;
    const view = createQueuedRunCard({
      promptId, bindingId: binding.id, bindingGeneration: binding.generation, title: formatPromptTitle(body), sessionTitle: binding.title, agentKind: binding.agentKind,
      workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.projects.spaceNameForBinding(binding), requestText: body, occurredAt: acceptedAt,
      conversionParentPromptId: capturedParentPromptId, queuePosition: this.options.store.countPendingPrompts(binding.id) + 1
    });
    let receipt;
    try {
      receipt = this.options.store.acceptPromptWithEffects({
        prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body },
        view, rootMessageId: answerRootMessageId, answerCard: this.options.presentation.answerCard(view),
        maxQueueDepth: this.options.config.maxQueueDepth, expectedBindingGeneration: binding.generation
      });
    } catch (error) {
      if (error instanceof Error && error.message === "This topic's prompt queue is full") {
        await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(error.message));
        return null;
      }
      throw error;
    }
    if (!receipt.result.inserted) return { promptId: receipt.result.prompt.id };
    await executePromptAcceptanceEffects(receipt, this.options);
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.queue", target: binding.id, outcome: "success" });
    return { promptId: receipt.result.prompt.id };
  }
}
