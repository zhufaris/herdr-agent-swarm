import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, InboundStore, LarkPort, OutboundIntentPort, PromptAcceptanceStore } from "../domain/ports.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin, IncomingLarkCardAction, IncomingLarkMessage } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { HerdrRuntimeReconcilerPort } from "./herdr-runtime-reconciler.js";
import type { OperationsWorkflowPort } from "./operations-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { RetiredPaneCleanupWorkflowPort } from "./retired-pane-cleanup-workflow.js";
import type { StartupViewConvergerPort } from "./startup-view-converger.js";

export interface InboundRouterPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  handleCardAction(action: IncomingLarkCardAction): Promise<void>;
}

type InboundRouterStore = InboundStore & PromptAcceptanceStore;
export interface InboundRouterOptions {
  config: BridgeConfig;
  store: InboundRouterStore;
  herdr: Pick<HerdrPort, "assertWorkspace" | "sendEscape">;
  lark: Pick<LarkPort, "start" | "stop">;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  scheduler: PromptWorkScheduler;
  inboundWork: InboundWorkNotifier;
  promptRun: PromptRunWorkflowPort;
  provisioning: BindingProvisioningWorkflowPort;
  operations: OperationsWorkflowPort;
  reconciler: HerdrRuntimeReconcilerPort;
  retiredPaneCleanup: RetiredPaneCleanupWorkflowPort;
  startupViews: StartupViewConvergerPort;
}

export class InboundRouter implements InboundRouterPort {
  private inboundDrain: Promise<void> | null = null;
  private stopInboundSubscription: (() => void) | null = null;

  constructor(private readonly options: InboundRouterOptions) {}

  async start(): Promise<void> {
    const { config, store, herdr, lark, logger, promptRun, reconciler, operations, provisioning, retiredPaneCleanup, inboundWork, startupViews } = this.options;
    promptRun.prepareRecovery();
    const recoveredLegacyCards = store.recoverLegacyElementIdDeadLetters();
    if (recoveredLegacyCards > 0) logger.warn({ event: "startup-legacy-answer-cards-recovered", recovered: recoveredLegacyCards, outcome: "requeued" }, "requeued answer cards rejected for the legacy element id format");
    await startupViews.converge();
    const recoveredInbound = store.recoverProcessingInboundMessages();
    if (recoveredInbound > 0) logger.warn({ event: "startup-inbound-recovered", recovered: recoveredInbound, outcome: "requeued" }, "returned interrupted inbound messages to acceptance queue");
    for (const workspaceId of new Set(config.projects.map((project) => project.workspaceId))) await herdr.assertWorkspace(workspaceId);
    await reconciler.captureBaselines();
    await operations.recover();
    await retiredPaneCleanup.recover();
    await reconciler.reconcile();
    promptRun.start();
    reconciler.start(config.reconcileIntervalMs);
    retiredPaneCleanup.start(config.reconcileIntervalMs);
    this.stopInboundSubscription = inboundWork.subscribe((event) => this.acceptInboundMessage(event.payload));
    await lark.start((message) => this.handleMessage(message), (action) => this.handleCardAction(action));
    await provisioning.recover();
    await this.drainInboundMessages();
  }

  async stop(): Promise<void> {
    await this.options.lark.stop();
    this.stopInboundSubscription?.();
    await Promise.allSettled([this.options.retiredPaneCleanup.stop(), this.options.reconciler.stop(), this.options.promptRun.stop(), ...(this.inboundDrain ? [this.inboundDrain] : [])]);
  }

  reconcileHerdrWorkspaces(workspaceIds?: readonly string[]): Promise<void> { return this.options.reconciler.requestReconciliation(workspaceIds); }
  async reconcile(): Promise<void> { await Promise.all([this.options.reconciler.reconcile(), this.options.retiredPaneCleanup.requestScan()]); }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    const { config, logger, store } = this.options;
    if (message.chatId !== config.lark.chatId) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message"); return; }
    if (store.isBridgeMessage(message.messageId)) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message"); return; }
    if (!store.recordInboundMessage(message)) { logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message"); return; }
    await this.drainInboundMessages();
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<void> {
    if (action.chatId !== this.options.config.lark.chatId) return;
    const model = parseModelSelectionAction(action.value, action.option);
    if (model) return this.options.operations.selectModel(action, model.bindingId, model.model);
    const open = parseOpenThreadAction(action.value);
    if (open) return this.options.operations.openThread(action, open.bindingId);
    const deadLetter = parseDeadLetterAction(action.value);
    if (deadLetter) return this.options.operations.decideDeadLetter(action, deadLetter.replyId, deadLetter.action);
    const paneClaim = parsePaneClaimAction(action.value);
    if (paneClaim) {
      const project = this.options.config.projects.find((candidate) => candidate.id === paneClaim.projectId && candidate.workspaceId === paneClaim.workspaceId);
      if (!project) return;
      const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${paneClaim.paneId}`, messageId: action.messageId, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/herdr attach ${projectSpaceName(project)} ${paneClaim.paneId}`, mentionsBot: true, isRootMessage: true };
      const attached = await this.options.provisioning.attach(synthetic, projectSpaceName(project), paneClaim.paneId);
      this.options.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: paneClaim.paneId, outcome: attached ? "attached" : "rejected" }, "processed Space pane claim");
      return;
    }
    const selection = parseProjectAction(action.value);
    if (selection) await this.options.provisioning.completeSelection(action, selection.selectionId, selection.projectId);
  }

  private async drainInboundMessages(): Promise<void> {
    const previous = this.inboundDrain ?? Promise.resolve(); const drain = previous.catch(() => undefined).then(() => this.drainInboundMessagesOnce()); this.inboundDrain = drain;
    try { await drain; } finally { if (this.inboundDrain === drain) this.inboundDrain = null; }
  }

  private async drainInboundMessagesOnce(): Promise<void> {
    for (let message = this.options.store.claimNextInboundMessage(); message; message = this.options.store.claimNextInboundMessage()) {
      try { await this.options.inboundWork.notify({ eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message }); this.options.store.markInboundMessageAccepted(message.eventId); }
      catch (error) { this.options.store.releaseInboundMessage(message.eventId, errorMessage(error)); this.options.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry"); return; }
    }
  }

  private async acceptInboundMessage(message: IncomingLarkMessage): Promise<void> {
    const command = parseCommand(message.text); const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    const decision = command ? `command:${command.kind}` : binding?.state === "active" && binding.lifecycle === "active" ? "prompt" : message.isRootMessage && message.mentionsBot ? "create_binding" : binding?.state === "archived" ? "archived_feedback" : "unbound_feedback";
    this.options.logger.info({ event: "lark-message-routed", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, workspaceId: binding?.workspaceId, paneId: binding?.paneId, decision, outcome: "accepted" }, "routed persisted Lark message");
    let disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected" = "command_completed";
    try {
      if (command?.kind === "help") await this.reply(message.rootMessageId ?? message.messageId, renderHelpCard());
      else if (command?.kind === "stop") disposition = await this.stopActiveTurn(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "steer") disposition = await this.steerActiveTurn(message, binding, command.text) ? "prompt_queued" : "rejected";
      else if (command?.kind === "model") disposition = await this.options.operations.runModel(message, binding, command.name) ? "command_completed" : "rejected";
      else if (command?.kind === "reset") disposition = await this.options.provisioning.reset(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "new" || command?.kind === "projects") await this.options.provisioning.selectProject(message, command.kind === "new" ? command.title : null);
      else if (command?.kind === "spaces") await this.options.operations.listSpaces(message);
      else if (command?.kind === "sessions") await this.options.operations.listSessions(message);
      else if (command?.kind === "failures") await this.options.operations.listFailures(message);
      else if (command?.kind === "attach") disposition = await this.options.provisioning.attach(message, command.spaceName, command.paneId) ? "command_completed" : "rejected";
      else if (command?.kind === "status") { if (!binding) { await this.reject(message, "这个话题尚未连接 Herdr。请发送 `/herdr new` 创建项目。"); disposition = "rejected"; } else await this.options.operations.emitStatus(binding); }
      else if (command?.kind === "rename") disposition = await this.options.operations.rename(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "close") disposition = await this.options.operations.archive(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_request") disposition = await this.options.operations.requestPaneClose(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_confirm") disposition = await this.options.operations.confirmPaneClose(message, binding, command.code) ? "command_completed" : "rejected";
      else if (command?.kind === "reattach") { if (!binding || binding.attachment !== "orphaned") { await this.reject(message, "当前会话不处于 orphaned 状态，无需重新连接。"); disposition = "rejected"; } else await this.options.provisioning.reattach(binding, command.paneId, message.actorOpenId); }
      else if (command?.kind === "replace") { if (!binding || binding.attachment !== "orphaned") { await this.reject(message, "只有 orphaned 会话可以创建 replacement Pane。"); disposition = "rejected"; } else await this.options.provisioning.replace(binding, message.actorOpenId); }
      else if (command?.kind === "resume") disposition = await this.options.operations.resume(message, binding) ? "command_completed" : "rejected";
      else if (binding?.state === "active" && binding.lifecycle === "active") { await this.enqueue(binding, message); disposition = "prompt_queued"; }
      else if (message.isRootMessage && message.mentionsBot) { const created = await this.options.provisioning.createRoot(message, deriveTopicTitle(message.text)); await this.enqueue(created, message, message.text); disposition = "prompt_queued"; }
      else { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, renderDisconnectedTopicCard(binding?.state === "archived" ? "archived" : "unbound")); disposition = "user_feedback"; }
    } catch (error) { this.options.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed"); throw error; }
    this.options.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text, forcedParentPromptId?: string): Promise<void> {
    if (!forcedParentPromptId && this.options.store.countPendingPrompts(binding.id) >= this.options.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID(); const occurredAt = new Date().toISOString(); const parentPromptId = forcedParentPromptId ?? null; const dispatchKind = parentPromptId ? "steering" as const : "turn" as const;
    const view = createQueuedRunCard({ promptId, bindingId: binding.id, title: requestTitle(body), workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, queuePosition: dispatchKind === "steering" ? 0 : this.options.store.countPendingPrompts(binding.id) + 1, occurredAt });
    const { prompt, inserted } = this.options.store.acceptPrompt({ prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body, dispatchKind, parentPromptId }, view, rootMessageId: binding.rootMessageId, answerCard: renderRequestAnswerCard(view) });
    this.options.outboundWork.wake();
    if (!inserted) { if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.options.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId }); else this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); return; }
    const depth = this.options.store.countPendingPrompts(binding.id);
    this.options.logger.info({ event: "prompt-dispatch-decided", eventId: message.eventId, messageId: message.messageId, bindingId: binding.id, promptId: prompt.id, parentPromptId, workspaceId: binding.workspaceId, paneId: binding.paneId, dispatchKind, queueDepth: depth, outcome: "accepted" }, "accepted Lark prompt dispatch decision");
    await this.publish(binding.id, dispatchKind === "steering" ? "SteeringQueued" : "PromptQueued", "lark", dispatchKind === "steering" ? { promptId: prompt.id, parentPromptId: parentPromptId!, actorOpenId: message.actorOpenId } : { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: dispatchKind === "steering" ? "prompt.steer" : "prompt.queue", target: binding.id, outcome: "success" });
    if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.options.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId }); else this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  }

  private async stopActiveTurn(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可停止的活动任务。`/stop` 未进入任务队列。"); return false; }
    const activeRun = this.options.promptRun.activeTurn(binding.id); if (!activeRun) { await this.reject(message, "当前没有可停止的活动 TraeX 任务。`/stop` 未进入任务队列。"); return false; }
    if (!this.options.herdr.sendEscape) { await this.reject(message, "当前 Herdr 适配器不支持 Esc 停止。"); return false; }
    try {
      await this.options.herdr.sendEscape(activeRun.paneId);
      this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.stop", target: binding.id, outcome: "success" });
      return true;
    } catch (error) {
      await this.reject(message, `发送停止信号失败：${errorMessage(error)}`);
      this.options.logger.warn({ event: "stop-escape-failed", err: safeLogError(error), bindingId: binding.id, paneId: activeRun.paneId, outcome: "failed" }, "failed to send stop Escape");
      return false;
    }
  }

  private async steerActiveTurn(message: IncomingLarkMessage, binding: Binding | null, text: string): Promise<boolean> {
    if (!binding || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可 steering 的活动任务。"); return false; }
    const activeRun = this.options.promptRun.activeTurn(binding.id);
    if (!activeRun) { await this.reject(message, "当前没有可 steering 的活动 TraeX 任务。`/steer` 未进入任务队列。"); return false; }
    await this.enqueue(binding, message, text, activeRun.promptId);
    return true;
  }

  private spaceNameFor(binding: Binding): string { const matches = binding.projectId ? this.options.config.projects.filter((project) => project.id === binding.projectId) : this.options.config.projects.filter((project) => project.workspaceId === binding.workspaceId); return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved"; }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent<T>(bindingId, type, origin, payload)); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requestTitle(body: string): string { const normalized = body.replace(/\s+/g, " " ).trim(); return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request"; }
function parseOpenThreadAction(value: unknown): { bindingId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "open_project_thread" && typeof item.bindingId === "string" ? { bindingId: item.bindingId } : null; }
function parseModelSelectionAction(value: unknown, option?: string | null): { bindingId: string; model: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model" && typeof item.bindingId === "string" && /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i.test(option) ? { bindingId: item.bindingId, model: option } : null; }
function parseDeadLetterAction(value: unknown): { action: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return (item.action === "retry_dead_letter" || item.action === "dismiss_dead_letter") && typeof item.replyId === "string" ? { action: item.action, replyId: item.replyId } : null; }
function parsePaneClaimAction(value: unknown): { projectId: string; workspaceId: string; paneId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "claim_pane" && typeof item.projectId === "string" && typeof item.workspaceId === "string" && typeof item.paneId === "string" ? { projectId: item.projectId, workspaceId: item.workspaceId, paneId: item.paneId } : null; }
function parseProjectAction(value: unknown): { selectionId: string; projectId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "select_project" && typeof item.selectionId === "string" && typeof item.projectId === "string" ? { selectionId: item.selectionId, projectId: item.projectId } : null; }
