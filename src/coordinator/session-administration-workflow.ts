import type { BridgeConfig } from "../config.js";
import { projectSpaceName } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { SessionAdministrationStore } from "../domain/ports/workflow.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, IncomingLarkMessage } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { requireMatchingPane } from "./pane-runtime-identity.js";
import { ProjectCatalog } from "./project-catalog.js";

interface Options {
  config: BridgeConfig;
  store: SessionAdministrationStore;
  herdr: Pick<HerdrPort, "observeRuntime" | "renamePane">;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: Pick<OutboundIntentPort, "enqueueCard">;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  isBindingBusy(bindingId: string): boolean;
  presentation: Pick<PrimaryPresentation, "mainCard" | "answerCard" | "requestRejected">;
}
export interface SessionAdministrationWorkflowPort {
  emitStatus(binding: Binding): Promise<void>;
  rename(message: IncomingLarkMessage, binding: Binding | null, title: string): Promise<boolean>;
  archive(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  resume(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
}
export class SessionAdministrationWorkflow implements SessionAdministrationWorkflowPort {
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
  }

  async emitStatus(binding: Binding): Promise<void> { await this.publish(binding.id, "AgentStateChanged", "bridge", { state: binding.lastAgentState, queueDepth: this.options.store.countPendingPrompts(binding.id) }); }

  async rename(message: IncomingLarkMessage, binding: Binding | null, title: string): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "这个话题没有可重命名的活动 Pane。请进入活动项目话题，或发送 /swarm new。"); return false; }
    const pane = await requireMatchingPane(this.options.herdr, this.projects, binding, binding.paneId); const project = binding.projectId ? this.projects.projectById(binding.projectId) : undefined;
    const displayTitle = formatProjectPaneTitle(project ? projectSpaceName(project) : null, pane.cwd ?? this.options.config.herdr.workspaceCwd, title, binding.paneId);
    await this.options.herdr.renamePane(binding.paneId, title, { tabTitle: title }); this.options.store.updateBindingMetadata(binding.id, { title: displayTitle }); await this.publish(binding.id, "BindingRenamed", "lark", { title: displayTitle }); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "binding.rename", target: binding.id, outcome: "success" }); return true;
  }

  async archive(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding || binding.lifecycle !== "active") { await this.reject(message, "这个话题没有可归档的活动会话。"); return false; }
    const { store } = this.options; const active = this.options.isBindingBusy(binding.id); const reason = active ? "停止接收新消息；当前任务完成后归档。" : "已从飞书归档；Herdr pane 与 TraeX 保持运行。";
    const cancellationReason = "话题已归档，排队任务已取消。"; const occurredAt = new Date().toISOString();
    const cancelled = store.cancelQueuedPromptsWithProjection({ bindingId: binding.id, reason: cancellationReason, occurredAt, rootMessageId: binding.rootMessageId, renderRunCard: this.options.presentation.answerCard });
    for (const promptId of cancelled.cancelledPromptIds) await this.publishAt(binding.id, "PromptCancelled", "bridge", { promptId, reason: cancellationReason }, occurredAt);
    const type = active ? "BindingDraining" as const : "BindingArchived" as const;
    const transitioned = await this.transitionAndPublish(binding, { type: "archive_requested", hasActiveTurn: active }, type, reason);
    store.audit({ actorOpenId: message.actorOpenId, action: "binding.archive", target: binding.id, outcome: transitioned.binding.lifecycle });
    if (cancelled.outboxReserved || transitioned.outboxReserved) this.options.outboundWork.wake();
    return true;
  }

  async resume(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding?.paneId || binding.lifecycle !== "archived") { await this.reject(message, "只有已归档且仍保留 Pane 的会话可以恢复。"); return false; }
    const pane = await requireMatchingPane(this.options.herdr, this.projects, binding, binding.paneId);
    const resumed = this.options.store.transitionBinding(binding.id, { type: "activate", runtime: pane.agentState });
    await this.publish(resumed.id, "BindingActivated", "lark", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: resumed.topicId! }); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "binding.resume", target: binding.id, outcome: "success" }); this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); return true;
  }

  private async transitionAndPublish(binding: Binding, transition: import("../domain/pane-thread-lifecycle.js").SessionTransition, type: "BindingDraining" | "BindingArchived", reason: string): Promise<{ binding: Binding; outboxReserved: boolean }> {
    const event = createBridgeEvent(binding.id, type, "lark", { reason }); const current = this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id); const view = reduceTopicView(current, event);
    if (!binding.statusMessageId) { const next = this.options.store.transitionBinding(binding.id, transition); await this.options.lifecycleEvents.publish(event); return { binding: next, outboxReserved: false }; }
    const next = this.options.store.transitionBindingWithOutbox({ id: binding.id, transition, event, view, messageId: binding.statusMessageId, card: this.options.presentation.mainCard(view) }); await this.options.lifecycleEvents.publish(event); return { binding: next, outboxReserved: true };
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
  private async publish(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload) as ReturnType<typeof createBridgeEvent>); }
  private async publishAt(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3], occurredAt: string): Promise<void> { await this.options.lifecycleEvents.publish({ ...createBridgeEvent(bindingId, type, origin, payload), occurredAt } as ReturnType<typeof createBridgeEvent>); }
}
