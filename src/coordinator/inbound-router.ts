import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingProvisioningStore, HerdrPort, InboundStore, LarkPort, OperationsStore, PromptAcceptanceStore, PromptRunStore, RuntimeReconciliationStore } from "../domain/ports.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../domain/topic-view.js";
import type { Binding, EventOrigin, IncomingLarkCardAction, IncomingLarkMessage } from "../domain/types.js";
import type { BridgeEventBus } from "../events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier, type InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { LarkOutboxDispatcher } from "../events/lark-outbox-dispatcher.js";
import { InProcessPromptWorkScheduler, type PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { BindingProvisioningWorkflow } from "./binding-provisioning-workflow.js";
import { HerdrRuntimeReconciler } from "./herdr-runtime-reconciler.js";
import { OperationsWorkflow } from "./operations-workflow.js";
import { PromptRunWorkflow } from "./prompt-run-workflow.js";

export interface InboundRouterPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  handleCardAction(action: IncomingLarkCardAction): Promise<void>;
}

type ApplicationStore = InboundStore & PromptAcceptanceStore & PromptRunStore & BindingProvisioningStore & OperationsStore & RuntimeReconciliationStore;

export class InboundRouter implements InboundRouterPort {
  private readonly scheduler: PromptWorkScheduler;
  private readonly inboundWork: InboundWorkNotifier;
  private readonly promptRun: PromptRunWorkflow;
  private readonly reconciler: HerdrRuntimeReconciler;
  private readonly provisioning: BindingProvisioningWorkflow;
  private readonly operations: OperationsWorkflow;
  private inboundDrain: Promise<void> | null = null;
  private stopInboundSubscription: (() => void) | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: ApplicationStore,
    private readonly herdr: HerdrPort,
    private readonly lark: LarkPort,
    private readonly bus: BridgeEventBus,
    private readonly outbound: LarkOutboxDispatcher,
    private readonly logger: Logger,
    shutdownGraceMs = 30_000,
    scheduler?: PromptWorkScheduler,
    inboundWork?: InboundWorkNotifier
  ) {
    this.scheduler = scheduler ?? new InProcessPromptWorkScheduler(logger);
    this.inboundWork = inboundWork ?? new InProcessInboundWorkNotifier();
    outbound.connectPromptScheduler(this.scheduler);
    this.promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler: this.scheduler, channelPublisher: outbound, logger, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs });
    this.provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound, scheduler: this.scheduler, logger });
    this.operations = new OperationsWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound, scheduler: this.scheduler, isBindingBusy: (bindingId) => this.promptRun.isBindingBusy(bindingId), logger });
    this.reconciler = new HerdrRuntimeReconciler({
      projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: outbound, logger,
      discoverPane: (pane, project) => this.provisioning.discover(pane, project), scheduler: this.scheduler,
      isBindingBusy: (bindingId) => this.promptRun.isBindingBusy(bindingId)
    });
  }

  async start(): Promise<void> {
    this.promptRun.prepareRecovery();
    const recoveredLegacyCards = this.store.recoverLegacyElementIdDeadLetters();
    if (recoveredLegacyCards > 0) this.logger.warn({ event: "startup-legacy-answer-cards-recovered", recovered: recoveredLegacyCards, outcome: "requeued" }, "requeued answer cards rejected for the legacy element id format");
    await this.convergeViews();
    const recoveredInbound = this.store.recoverProcessingInboundMessages();
    if (recoveredInbound > 0) this.logger.warn({ event: "startup-inbound-recovered", recovered: recoveredInbound, outcome: "requeued" }, "returned interrupted inbound messages to acceptance queue");
    for (const workspaceId of new Set(this.config.projects.map((project) => project.workspaceId))) await this.herdr.assertWorkspace(workspaceId);
    await this.reconciler.captureBaselines();
    await this.operations.recover();
    await this.reconciler.reconcile();
    this.promptRun.start();
    this.reconciler.start(this.config.reconcileIntervalMs);
    this.stopInboundSubscription = this.inboundWork.subscribe((event) => this.acceptInboundMessage(event.payload));
    await this.lark.start((message) => this.handleMessage(message), (action) => this.handleCardAction(action));
    await this.provisioning.recover();
    await this.outbound.drain();
    await this.drainInboundMessages();
  }

  async stop(): Promise<void> {
    await this.lark.stop();
    this.stopInboundSubscription?.();
    await Promise.allSettled([this.reconciler.stop(), this.promptRun.stop(), ...(this.inboundDrain ? [this.inboundDrain] : [])]);
  }

  reconcileHerdrWorkspaces(workspaceIds?: readonly string[]): Promise<void> { return this.reconciler.requestReconciliation(workspaceIds); }
  reconcile(): Promise<void> { return this.reconciler.reconcile(); }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    if (message.chatId !== this.config.lark.chatId) { this.logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message"); return; }
    if (this.store.isBridgeMessage(message.messageId)) { this.logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message"); return; }
    if (!this.store.recordInboundMessage(message)) { this.logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message"); return; }
    await this.drainInboundMessages();
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<void> {
    if (action.chatId !== this.config.lark.chatId) return;
    const model = parseModelSelectionAction(action.value, action.option);
    if (model) return this.operations.selectModel(action, model.bindingId, model.model);
    const open = parseOpenThreadAction(action.value);
    if (open) return this.operations.openThread(action, open.bindingId);
    const deadLetter = parseDeadLetterAction(action.value);
    if (deadLetter) return this.operations.decideDeadLetter(action, deadLetter.replyId, deadLetter.action);
    const paneClaim = parsePaneClaimAction(action.value);
    if (paneClaim) {
      const project = this.config.projects.find((candidate) => candidate.id === paneClaim.projectId && candidate.workspaceId === paneClaim.workspaceId);
      if (!project) return;
      const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${paneClaim.paneId}`, messageId: action.messageId, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/herdr attach ${projectSpaceName(project)} ${paneClaim.paneId}`, mentionsBot: true, isRootMessage: true };
      const attached = await this.provisioning.attach(synthetic, projectSpaceName(project), paneClaim.paneId);
      this.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: paneClaim.paneId, outcome: attached ? "attached" : "rejected" }, "processed Space pane claim");
      return;
    }
    const selection = parseProjectAction(action.value);
    if (selection) await this.provisioning.completeSelection(action, selection.selectionId, selection.projectId);
  }

  private async convergeViews(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      const spaceName = this.spaceNameFor(binding);
      const topicView = this.store.loadTopicView(binding.id);
      if (topicView && topicView.spaceName !== spaceName) { const current = { ...topicView, spaceName }; this.store.saveTopicView(current); if (binding.statusMessageId) await this.outbound.enqueueCardUpdate(binding.id, binding.statusMessageId, `space-name:${binding.id}:${spaceName}`, renderProjectEntryCard(current)); }
      const runCards = this.store.listRunCards(binding.id);
      for (const view of runCards.filter((item) => item.larkMessageId)) {
        if (!view.answerMessageId && binding.rootMessageId) this.store.ensureAnswerCard(view.promptId, binding.rootMessageId, renderRequestAnswerCard(view));
        const current = view.spaceName !== spaceName ? this.store.saveRunCard({ ...view, spaceName, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerCardId && current.answerMessageId && (view.spaceName !== spaceName || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", renderRequestAnswerCard(current));
      }
      const latestRun = runCards.at(-1); const currentTopic = this.store.loadTopicView(binding.id);
      if (latestRun && currentTopic && binding.statusMessageId) { const mirrored = mirrorRunCardToTopic(currentTopic, latestRun); this.store.saveTopicView(mirrored); await this.outbound.enqueueCardUpdate(binding.id, binding.statusMessageId, `startup-primary-sync:${binding.id}:${latestRun.promptId}:${latestRun.viewVersion}`, renderProjectEntryCard(mirrored)); }
    }
  }

  private async drainInboundMessages(): Promise<void> {
    const previous = this.inboundDrain ?? Promise.resolve(); const drain = previous.catch(() => undefined).then(() => this.drainInboundMessagesOnce()); this.inboundDrain = drain;
    try { await drain; } finally { if (this.inboundDrain === drain) this.inboundDrain = null; }
  }

  private async drainInboundMessagesOnce(): Promise<void> {
    for (let message = this.store.claimNextInboundMessage(); message; message = this.store.claimNextInboundMessage()) {
      try { await this.inboundWork.notify({ eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message }); this.store.markInboundMessageAccepted(message.eventId); }
      catch (error) { this.store.releaseInboundMessage(message.eventId, errorMessage(error)); this.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry"); return; }
    }
  }

  private async acceptInboundMessage(message: IncomingLarkMessage): Promise<void> {
    const command = parseCommand(message.text); const binding = this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    const decision = command ? `command:${command.kind}` : binding?.state === "active" && binding.lifecycle === "active" ? "prompt" : message.isRootMessage && message.mentionsBot ? "create_binding" : binding?.state === "archived" ? "archived_feedback" : "unbound_feedback";
    this.logger.info({ event: "lark-message-routed", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, workspaceId: binding?.workspaceId, paneId: binding?.paneId, decision, outcome: "accepted" }, "routed persisted Lark message");
    let disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected" = "command_completed";
    try {
      if (command?.kind === "help") await this.reply(message.rootMessageId ?? message.messageId, renderHelpCard());
      else if (command?.kind === "stop") disposition = await this.stopActiveTurn(message, binding) ? "prompt_queued" : "rejected";
      else if (command?.kind === "model") disposition = await this.operations.runModel(message, binding, command.name) ? "command_completed" : "rejected";
      else if (command?.kind === "reset") disposition = await this.provisioning.reset(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "new" || command?.kind === "projects") await this.provisioning.selectProject(message, command.kind === "new" ? command.title : null);
      else if (command?.kind === "spaces") await this.operations.listSpaces(message);
      else if (command?.kind === "sessions") await this.operations.listSessions(message);
      else if (command?.kind === "failures") await this.operations.listFailures(message);
      else if (command?.kind === "attach") disposition = await this.provisioning.attach(message, command.spaceName, command.paneId) ? "command_completed" : "rejected";
      else if (command?.kind === "status") { if (!binding) { await this.reject(message, "这个话题尚未连接 Herdr。请发送 `/herdr new` 创建项目。"); disposition = "rejected"; } else await this.operations.emitStatus(binding); }
      else if (command?.kind === "rename") disposition = await this.operations.rename(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "close") disposition = await this.operations.archive(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_request") disposition = await this.operations.requestPaneClose(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_confirm") disposition = await this.operations.confirmPaneClose(message, binding, command.code) ? "command_completed" : "rejected";
      else if (command?.kind === "reattach") { if (!binding || binding.attachment !== "orphaned") { await this.reject(message, "当前会话不处于 orphaned 状态，无需重新连接。"); disposition = "rejected"; } else await this.provisioning.reattach(binding, command.paneId, message.actorOpenId); }
      else if (command?.kind === "replace") { if (!binding || binding.attachment !== "orphaned") { await this.reject(message, "只有 orphaned 会话可以创建 replacement Pane。"); disposition = "rejected"; } else await this.provisioning.replace(binding, message.actorOpenId); }
      else if (command?.kind === "resume") disposition = await this.operations.resume(message, binding) ? "command_completed" : "rejected";
      else if (binding?.state === "active" && binding.lifecycle === "active") { await this.enqueue(binding, message); disposition = "prompt_queued"; }
      else if (message.isRootMessage && message.mentionsBot) { const created = await this.provisioning.createRoot(message, deriveTopicTitle(message.text)); await this.enqueue(created, message, message.text); disposition = "prompt_queued"; }
      else { await this.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, renderDisconnectedTopicCard(binding?.state === "archived" ? "archived" : "unbound")); disposition = "user_feedback"; }
    } catch (error) { this.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed"); throw error; }
    this.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text, forcedParentPromptId?: string): Promise<void> {
    if (!forcedParentPromptId && this.store.countPendingPrompts(binding.id) >= this.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID(); const occurredAt = new Date().toISOString(); const activeRun = this.promptRun.activeTurn(binding.id); const parentPromptId = forcedParentPromptId ?? (activeRun?.state === "working" ? activeRun.promptId : null); const dispatchKind = parentPromptId ? "steering" as const : "turn" as const;
    const view = createQueuedRunCard({ promptId, bindingId: binding.id, title: requestTitle(body), workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, queuePosition: dispatchKind === "steering" ? 0 : this.store.countPendingPrompts(binding.id) + 1, occurredAt });
    const { prompt, inserted } = this.store.acceptPrompt({ prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body, dispatchKind, parentPromptId }, view, rootMessageId: binding.rootMessageId, answerCard: renderRequestAnswerCard(view) });
    if (!inserted) { await this.outbound.drain(); if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId }); else this.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); return; }
    const depth = this.store.countPendingPrompts(binding.id);
    this.logger.info({ event: "prompt-dispatch-decided", eventId: message.eventId, messageId: message.messageId, bindingId: binding.id, promptId: prompt.id, parentPromptId, workspaceId: binding.workspaceId, paneId: binding.paneId, dispatchKind, queueDepth: depth, outcome: "accepted" }, "accepted Lark prompt dispatch decision");
    await this.publish(binding.id, dispatchKind === "steering" ? "SteeringQueued" : "PromptQueued", "lark", dispatchKind === "steering" ? { promptId: prompt.id, parentPromptId: parentPromptId!, actorOpenId: message.actorOpenId } : { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    this.store.audit({ actorOpenId: message.actorOpenId, action: dispatchKind === "steering" ? "prompt.steer" : "prompt.queue", target: binding.id, outcome: "success" });
    await this.outbound.drain();
    if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId }); else this.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  }

  private async stopActiveTurn(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可停止的活动任务。`/stop` 未进入任务队列。"); return false; }
    const activeRun = this.promptRun.activeTurn(binding.id); if (!activeRun || activeRun.state !== "working") { await this.reject(message, "当前没有确认处于 working 的 TraeX 任务。`/stop` 未进入任务队列。"); return false; }
    await this.enqueue(binding, message, "/stop", activeRun.promptId); return true;
  }

  private spaceNameFor(binding: Binding): string { const matches = binding.projectId ? this.config.projects.filter((project) => project.id === binding.projectId) : this.config.projects.filter((project) => project.workspaceId === binding.workspaceId); return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved"; }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> { await this.bus.publish(createBridgeEvent<T>(bindingId, type, origin, payload)); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requestTitle(body: string): string { const normalized = body.replace(/\s+/g, " " ).trim(); return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request"; }
function parseOpenThreadAction(value: unknown): { bindingId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "open_project_thread" && typeof item.bindingId === "string" ? { bindingId: item.bindingId } : null; }
function parseModelSelectionAction(value: unknown, option?: string | null): { bindingId: string; model: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model" && typeof item.bindingId === "string" && /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i.test(option) ? { bindingId: item.bindingId, model: option } : null; }
function parseDeadLetterAction(value: unknown): { action: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return (item.action === "retry_dead_letter" || item.action === "dismiss_dead_letter") && typeof item.replyId === "string" ? { action: item.action, replyId: item.replyId } : null; }
function parsePaneClaimAction(value: unknown): { projectId: string; workspaceId: string; paneId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "claim_pane" && typeof item.projectId === "string" && typeof item.workspaceId === "string" && typeof item.paneId === "string" ? { projectId: item.projectId, workspaceId: item.workspaceId, paneId: item.paneId } : null; }
function parseProjectAction(value: unknown): { selectionId: string; projectId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "select_project" && typeof item.selectionId === "string" && typeof item.projectId === "string" ? { selectionId: item.selectionId, projectId: item.projectId } : null; }
