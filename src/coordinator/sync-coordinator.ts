import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderAttachStatusCard, renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderProjectEntryCard, renderProjectSelectionStatusCard, renderProjectSelectorCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { renderSpaceDirectoryCards, type SpaceDirectoryGroup } from "../cards/space-directory-card.js";
import { renderFailureCards, renderSessionCards } from "../cards/operations-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { renderModelResultCard } from "../cards/model-card.js";
import { renderPaneCloseConfirmationCard, renderPaneCloseResultCard } from "../cards/pane-close-card.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import { initialTopicView, mirrorRunCardToTopic, reduceTopicView } from "../domain/topic-view.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, EventOrigin, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import type { BridgeEventBus } from "../events/bridge-event-bus.js";
import type { LarkChannelPublisher } from "../events/lark-channel-publisher.js";
import { cleanTerminalOutput } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";
import { InProcessPromptWorkScheduler, type PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { InProcessInboundWorkNotifier, type InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import { PromptRunWorkflow } from "./prompt-run-workflow.js";
import { SessionReconciler } from "./session-reconciler.js";

export class SyncCoordinator {
  private readonly scheduler: PromptWorkScheduler;
  private readonly inboundWork: InboundWorkNotifier;
  private readonly promptRun: PromptRunWorkflow;
  private readonly reconciler: SessionReconciler;
  private inboundDrain: Promise<void> | null = null;
  private stopping = false;
  private stopInboundSubscription: (() => void) | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStorePort,
    private readonly herdr: HerdrPort,
    private readonly lark: LarkPort,
    private readonly bus: BridgeEventBus,
    private readonly channelPublisher: LarkChannelPublisher,
    private readonly logger: Logger,
    private readonly shutdownGraceMs = 30_000,
    scheduler?: PromptWorkScheduler,
    inboundWork?: InboundWorkNotifier
  ) {
    this.scheduler = scheduler ?? new InProcessPromptWorkScheduler(logger);
    this.inboundWork = inboundWork ?? new InProcessInboundWorkNotifier();
    channelPublisher.connectPromptScheduler(this.scheduler);
    this.promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler: this.scheduler, channelPublisher, logger, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs });
    this.reconciler = new SessionReconciler({
      projects: config.projects, store, herdr, bus, channelPublisher, logger,
      discoverPane: (pane, project) => this.createFromHerdr(pane, project),
      scheduler: this.scheduler,
      isBindingBusy: (bindingId) => this.promptRun.isBindingBusy(bindingId)
    });
  }

  async start(): Promise<void> {
    this.promptRun.prepareRecovery();
    const recoveredLegacyCards = this.store.recoverLegacyElementIdDeadLetters();
    if (recoveredLegacyCards > 0) this.logger.warn({ event: "startup-legacy-answer-cards-recovered", recovered: recoveredLegacyCards, outcome: "requeued" }, "requeued answer cards rejected for the legacy element id format");
    for (const binding of this.store.listBindings()) {
      const spaceName = this.spaceNameFor(binding);
      const topicView = this.store.loadTopicView(binding.id);
      if (topicView && topicView.spaceName !== spaceName) {
        const current = { ...topicView, spaceName };
        this.store.saveTopicView(current);
        if (binding.statusMessageId) await this.channelPublisher.enqueueCardUpdate(binding.id, binding.statusMessageId, `space-name:${binding.id}:${spaceName}`, renderProjectEntryCard(current));
      }
      const runCards = this.store.listRunCards(binding.id);
      for (const view of runCards.filter((item) => item.larkMessageId)) {
        if (!view.answerMessageId && binding.rootMessageId) this.store.ensureAnswerCard(view.promptId, binding.rootMessageId, renderRequestAnswerCard(view));
        const changed = view.spaceName !== spaceName;
        const current = changed ? this.store.saveRunCard({ ...view, spaceName, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerCardId && current.answerMessageId && (changed || current.viewVersion > current.answerDeliveredVersion)) await this.channelPublisher.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", renderRequestAnswerCard(current));
      }
      const latestRun = runCards.at(-1);
      const currentTopic = this.store.loadTopicView(binding.id);
      if (latestRun && currentTopic && binding.statusMessageId) {
        const mirrored = mirrorRunCardToTopic(currentTopic, latestRun);
        this.store.saveTopicView(mirrored);
        await this.channelPublisher.enqueueCardUpdate(binding.id, binding.statusMessageId, `startup-primary-sync:${binding.id}:${latestRun.promptId}:${latestRun.viewVersion}`, renderProjectEntryCard(mirrored));
      }
    }
    const recoveredInbound = this.store.recoverProcessingInboundMessages();
    if (recoveredInbound > 0) this.logger.warn({ event: "startup-inbound-recovered", recovered: recoveredInbound, outcome: "requeued" }, "returned interrupted inbound messages to acceptance queue");
    const recoverableSelections = this.store.listProcessingProjectSelections();
    for (const workspaceId of new Set(this.config.projects.map((project) => project.workspaceId))) await this.herdr.assertWorkspace(workspaceId);
    await this.reconciler.captureBaselines();
    await this.recoverPaneCloseOperations();
    await this.reconciler.reconcile();
    this.promptRun.start();
    this.reconciler.start(this.config.reconcileIntervalMs);
    this.stopInboundSubscription = this.inboundWork.subscribe((event) => this.acceptInboundMessage(event.payload));
    await this.lark.start((message) => this.handleMessage(message), (action) => this.handleCardAction(action));
    for (const selection of recoverableSelections) await this.recoverProjectSelection(selection);
    const selectionBindingIds = new Set(recoverableSelections.flatMap((selection) => selection.bindingId ? [selection.bindingId] : []));
    for (const binding of this.store.listBindings().filter((candidate) =>
      candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "runtime_started" && !selectionBindingIds.has(candidate.id)
    )) await this.recoverDiscoveredBinding(binding);
    await this.channelPublisher.drain();
    await this.drainInboundMessages();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.lark.stop();
    this.stopInboundSubscription?.();
    const pending = [
      this.reconciler.stop(),
      this.promptRun.stop(),
      ...(this.inboundDrain ? [this.inboundDrain] : [])
    ];
    await Promise.allSettled(pending);
  }

  reconcileHerdrWorkspaces(workspaceIds?: readonly string[]): Promise<void> {
    return this.reconciler.requestReconciliation(workspaceIds);
  }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    if (message.chatId !== this.config.lark.chatId) {
      this.logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message");
      return;
    }
    if (this.store.isBridgeMessage(message.messageId)) {
      this.logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message");
      return;
    }
    if (!this.store.recordInboundMessage(message)) {
      this.logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message");
      return;
    }
    await this.drainInboundMessages();
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<void> {
    if (action.chatId !== this.config.lark.chatId) return;
    const modelSelection = parseModelSelectionAction(action.value, action.option);
    if (modelSelection) {
      await this.runModelSelection(action, modelSelection.bindingId, modelSelection.model);
      return;
    }
    const openThread = parseOpenThreadAction(action.value);
    if (openThread) {
      const binding = this.store.getBinding(openThread.bindingId);
      if (!binding || binding.chatId !== action.chatId) return;
      const topicOrRootMessageId = binding.topicId ?? binding.rootMessageId;
      if (!topicOrRootMessageId) return;
      try {
        await this.lark.shareThread(topicOrRootMessageId, { messageId: action.messageId, chatId: action.chatId });
        this.store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "shared" });
      } catch (error) {
        this.logger.error({ event: "thread-entry-share-failed", err: safeLogError(error), bindingId: binding.id, actionMessageId: action.messageId, outcome: "failed" }, "failed to share project thread entry");
        await this.lark.replyText(action.messageId, "话题入口发送失败，请重新执行 `/herdr spaces` 后重试。");
        this.store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "failed" });
      }
      return;
    }
    const deadLetter = parseDeadLetterAction(action.value);
    if (deadLetter) {
      const outcome = deadLetter.action === "retry_dead_letter"
        ? this.store.retryDeadLetter(deadLetter.replyId, action.chatId, action.operatorOpenId)
        : this.store.dismissDeadLetter(deadLetter.replyId, action.chatId, action.operatorOpenId);
      this.logger.info({ event: "dead-letter-action-decided", replyId: deadLetter.replyId, action: deadLetter.action, outcome }, "processed dead-letter action");
      if (outcome === "retried") await this.channelPublisher.retryPending();
      const notice = outcome === "retried" ? "已重新提交该消息发送；不会重放 TraeX 任务。" : outcome === "dismissed" ? "已忽略该发送失败并保留历史记录。" : "该操作已失效或无权执行。";
      const cards = renderFailureCards(this.store.listFailures(action.chatId), notice);
      await this.channelPublisher.enqueueCardUpdate(null, action.messageId, `failures:${action.messageId}:${deadLetter.replyId}:${outcome}`, cards[0]!);
      return;
    }
    const paneClaim = parsePaneClaimAction(action.value);
    if (paneClaim) {
      const project = this.config.projects.find((candidate) => candidate.id === paneClaim.projectId && candidate.workspaceId === paneClaim.workspaceId);
      if (!project) return;
      const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${paneClaim.paneId}`, messageId: action.messageId, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/herdr attach ${projectSpaceName(project)} ${paneClaim.paneId}`, mentionsBot: true, isRootMessage: true };
      const outcome = await this.attachExistingPane(synthetic, projectSpaceName(project), paneClaim.paneId);
      this.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: paneClaim.paneId, outcome: outcome ? "attached" : "rejected" }, "processed Space pane claim");
      return;
    }
    const value = parseProjectAction(action.value);
    if (!value) return;
    const claim = this.store.claimProjectSelection({
      selectionId: value.selectionId, projectId: value.projectId, messageId: action.messageId, chatId: action.chatId, actorOpenId: action.operatorOpenId,
      allowedProjectIds: this.config.projects.map((project) => project.id)
    });
    this.logger.info({ event: "project-selection-decided", selectionId: value.selectionId, projectId: value.projectId, messageId: action.messageId, outcome: claim.outcome }, "processed project selection action");
    this.store.audit({ actorOpenId: action.operatorOpenId, action: "project.select", target: `${value.selectionId}:${value.projectId}`, outcome: claim.outcome });
    if (claim.outcome === "missing" || !claim.selection) return;
    const selection = claim.selection;
    if (claim.outcome === "invalid") return;
    if (claim.outcome === "unauthorized") return;
    if (claim.outcome === "expired") {
      await this.channelPublisher.enqueueCardUpdate(null, action.messageId, `selection:${value.selectionId}:expired`, renderProjectSelectionStatusCard({ status: "expired", message: "请重新发送 /herdr new。" }));
      return;
    }
    if (claim.outcome === "processing") return;
    if (claim.outcome === "completed") {
      const binding = selection.bindingId ? this.store.getBinding(selection.bindingId) : null;
      const project = this.config.projects.find((item) => item.id === selection.selectedProjectId);
      if (binding && project) await this.publishSelectionSuccess(selection.id, action.messageId, project, binding);
      return;
    }
    const project = this.config.projects.find((item) => item.id === value.projectId);
    if (!project) return;
    await this.channelPublisher.enqueueCardUpdate(null, action.messageId, `selection:${value.selectionId}:processing`, renderProjectSelectionStatusCard({ status: "processing", projectName: project.displayName, spaceName: projectSpaceName(project) }));
    try {
      const binding = await this.createSelectedProject(selection, project, true);
      this.store.completeProjectSelection(selection.id, binding.id);
      await this.publishSelectionSuccess(selection.id, action.messageId, project, binding);
      this.store.audit({ actorOpenId: action.operatorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
    } catch (error) {
      this.store.pauseProjectSelection(selection.id, errorMessage(error));
      await this.channelPublisher.enqueueCardUpdate(null, action.messageId, `selection:${value.selectionId}:recoverable`, renderProjectSelectionStatusCard({
        status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project),
        message: provisioningRecoveryMessage(error)
      }));
      this.logger.error({ event: "project-selection-paused", err: safeLogError(error), selectionId: value.selectionId, projectId: project.id, outcome: "retry_on_restart" }, "project selection paused at a recoverable checkpoint");
    }
  }

  private async drainInboundMessages(): Promise<void> {
    const previous = this.inboundDrain ?? Promise.resolve();
    const drain = previous.catch(() => undefined).then(() => this.drainInboundMessagesOnce());
    this.inboundDrain = drain;
    try { await drain; }
    finally { if (this.inboundDrain === drain) this.inboundDrain = null; }
  }

  private async drainInboundMessagesOnce(): Promise<void> {
    for (let message = this.store.claimNextInboundMessage(); message; message = this.store.claimNextInboundMessage()) {
      try {
        await this.inboundWork.notify({
          eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message
        });
        this.store.markInboundMessageAccepted(message.eventId);
      } catch (error) {
        this.store.releaseInboundMessage(message.eventId, errorMessage(error));
        this.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry");
        return;
      }
    }
  }

  private async acceptInboundMessage(message: IncomingLarkMessage): Promise<void> {
    const command = parseCommand(message.text);
    const binding = this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    const decision = command ? `command:${command.kind}`
      : binding?.state === "active" && binding.lifecycle === "active" ? "prompt"
        : message.isRootMessage && message.mentionsBot ? "create_binding"
          : binding?.state === "archived" ? "archived_feedback" : "unbound_feedback";
    this.logger.info({ event: "lark-message-routed", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, workspaceId: binding?.workspaceId, paneId: binding?.paneId, decision, outcome: "accepted" }, "routed persisted Lark message");

    let disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected" = "command_completed";
    try {
      if (command?.kind === "help") {
        await this.replyStandalone(message.rootMessageId ?? message.messageId, renderHelpCard());
      } else if (command?.kind === "stop") {
        disposition = await this.stopActiveTurn(message, binding) ? "prompt_queued" : "rejected";
      } else if (command?.kind === "model") {
        disposition = await this.runModelCommand(message, binding, command.name) ? "command_completed" : "rejected";
      } else if (command?.kind === "reset") {
        disposition = await this.resetTopicSession(message, binding, command.title) ? "command_completed" : "rejected";
      } else if (command?.kind === "new" || command?.kind === "projects") {
        await this.createProjectSelector(message, command.kind === "new" ? command.title : null);
      } else if (command?.kind === "spaces") {
        await this.publishSpaceDirectory(message);
      } else if (command?.kind === "sessions") {
        await this.publishOperationCards(message, "sessions", renderSessionCards(this.store.listSessions(message.chatId)));
      } else if (command?.kind === "failures") {
        await this.publishOperationCards(message, "failures", renderFailureCards(this.store.listFailures(message.chatId)));
      } else if (command?.kind === "attach") {
        disposition = await this.attachExistingPane(message, command.spaceName, command.paneId) ? "command_completed" : "rejected";
      } else if (command?.kind === "status") {
        if (!binding) {
          await this.channelPublisher.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard("这个话题尚未连接 Herdr。请发送 `/herdr new` 创建项目。"));
          disposition = "rejected";
        } else await this.emitState(binding, binding.lastAgentState);
      } else if (command?.kind === "rename") {
        if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") {
          await this.channelPublisher.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard("这个话题没有可重命名的活动 Pane。请进入活动项目话题，或发送 `/herdr new`。"));
          disposition = "rejected";
        } else {
          const pane = await this.herdr.getPane(binding.paneId);
          const project = this.config.projects.find((candidate) => candidate.id === binding.projectId);
          const title = formatProjectPaneTitle(project ? projectSpaceName(project) : null, pane?.cwd ?? this.config.herdr.workspaceCwd, command.title, binding.paneId);
          await this.herdr.renamePane(binding.paneId, command.title, { tabTitle: command.title });
          this.store.updateBinding(binding.id, { title });
          await this.publish(binding.id, "BindingRenamed", "lark", { title });
          this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.rename", target: binding.id, outcome: "success" });
        }
      } else if (command?.kind === "close") {
        if (!binding || binding.lifecycle !== "active") {
          await this.channelPublisher.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard("这个话题没有可归档的活动会话。"));
          disposition = "rejected";
        } else await this.archiveBinding(binding, message.actorOpenId);
      } else if (command?.kind === "pane_close_request") {
        disposition = await this.requestPaneClose(message, binding) ? "command_completed" : "rejected";
      } else if (command?.kind === "pane_close_confirm") {
        disposition = await this.confirmPaneClose(message, binding, command.code) ? "command_completed" : "rejected";
      } else if (command?.kind === "reattach") {
        if (!binding || binding.attachment !== "orphaned") {
          await this.reject(message, "当前会话不处于 orphaned 状态，无需重新连接。"); disposition = "rejected";
        } else await this.reattachBinding(binding, command.paneId, false, message.actorOpenId);
      } else if (command?.kind === "replace") {
        if (!binding || binding.attachment !== "orphaned") {
          await this.reject(message, "只有 orphaned 会话可以创建 replacement Pane。"); disposition = "rejected";
        } else await this.replaceBinding(binding, message.actorOpenId);
      } else if (command?.kind === "resume") {
        if (!binding || binding.lifecycle !== "archived" || !binding.paneId) {
          await this.reject(message, "只有已归档且仍保留 Pane 的会话可以恢复。"); disposition = "rejected";
        } else {
          const pane = await this.requireMatchingPane(binding, binding.paneId);
          const resumed = this.store.transitionBinding(binding.id, { type: "activate" });
          await this.publish(resumed.id, "BindingActivated", "lark", { paneId: pane.paneId, topicId: resumed.topicId! });
          this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.resume", target: binding.id, outcome: "success" });
          this.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
        }
      } else if (binding?.state === "active" && binding.lifecycle === "active") {
        await this.enqueue(binding, message);
        disposition = "prompt_queued";
      } else if (message.isRootMessage && message.mentionsBot) {
        await this.createFromLark(message, deriveTopicTitle(message.text), message.text);
      } else {
        await this.channelPublisher.enqueueCard(
          message.rootMessageId ?? message.messageId,
          `disconnected-topic:${message.messageId}`,
          renderDisconnectedTopicCard(binding?.state === "archived" ? "archived" : "unbound")
        );
        disposition = "user_feedback";
      }
    } catch (error) {
      this.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed");
      throw error;
    }
    this.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async archiveBinding(binding: Binding, actorOpenId: string): Promise<void> {
    const hasActiveTurn = this.promptRun.activeTurn(binding.id) !== null;
    const reason = hasActiveTurn ? "停止接收新消息；当前任务完成后归档。" : "已从飞书归档；Herdr pane 与 TraeX 保持运行。";
    for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "queued")) {
      await this.publish(binding.id, "PromptCancelled", "bridge", { promptId: view.promptId, reason: "话题已归档，排队任务已取消。" });
    }
    this.store.cancelQueuedPrompts(binding.id, "话题已归档，排队任务已取消。");
    const type = hasActiveTurn ? "BindingDraining" as const : "BindingArchived" as const;
    const next = await this.transitionAndPublish(binding, { type: "archive_requested", hasActiveTurn }, type, "lark", { reason });
    this.store.audit({ actorOpenId, action: "binding.archive", target: binding.id, outcome: next.lifecycle });
  }

  private async resetTopicSession(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean> {
    if (!binding || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached" || !binding.projectId || !binding.topicId || !binding.rootMessageId) {
      await this.reject(message, "`/new` 只能在已连接且活动中的项目话题内使用。");
      return false;
    }
    const project = this.config.projects.find((candidate) => candidate.id === binding.projectId);
    if (!project) {
      await this.reject(message, "当前会话的项目配置已不存在，不能开启新会话。");
      return false;
    }
    const paneTitle = requestedTitle ?? randomPaneName();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    const handoff = this.store.resetTopicBinding({ oldBindingId: binding.id, newBindingId: randomUUID(), title, actorOpenId: message.actorOpenId });
    this.scheduler.wake({ kind: "binding-runtime-changed", bindingId: binding.id });
    try {
      let replacement = this.store.updateBinding(handoff.replacement.id, { statusMessageId: handoff.replacement.rootMessageId });
      const pane = await this.herdr.createPane(project.workspaceId, project.cwd, {
        bindingId: replacement.id, generation: replacement.generation, projectId: project.id, placement: "dedicated-tab", title: paneTitle
      });
      replacement = this.store.updateBinding(replacement.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
      replacement = this.store.transitionBinding(replacement.id, { type: "pane_created" });
      await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
      replacement = this.store.updateBinding(replacement.id, { lastAgentState: "idle" });
      replacement = this.store.transitionBinding(replacement.id, { type: "runtime_started" });
      replacement = this.store.transitionBinding(replacement.id, { type: "thread_created" });
      replacement = this.store.transitionBinding(replacement.id, { type: "activate" });
      await this.publish(replacement.id, "BindingCreated", "lark", { title, workspaceId: replacement.workspaceId, spaceName: projectSpaceName(project), paneId: pane.paneId });
      await this.publish(replacement.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: replacement.topicId! });
      await this.replyStandalone(replacement.rootMessageId!, renderMessageRejectedCard(`已开启新会话：${pane.paneId}。旧 Herdr pane 会继续运行，但其后续输出不会再发送到本话题。`));
      this.logger.info({ event: "binding-reset-completed", previousBindingId: handoff.previous.id, bindingId: replacement.id, paneId: pane.paneId, outcome: "active" }, "reset Lark topic to a new Herdr session");
      return true;
    } catch (error) {
      this.store.updateBinding(handoff.replacement.id, { state: "failed" });
      const detail = errorMessage(error);
      await this.reject(message, `旧会话已从本话题脱离，但新会话创建失败：${detail}。请先检查 Herdr；如果新 Pane 已出现，请用 \`/herdr attach <space> <pane>\` 认领它，避免重复创建。`);
      this.logger.error({ event: "binding-reset-failed", err: safeLogError(error), previousBindingId: handoff.previous.id, bindingId: handoff.replacement.id, outcome: "failed" }, "new session provisioning failed after topic reset");
      return false;
    }
  }

  private async requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    const checked = await this.checkPaneCloseSafety(message, binding);
    if (!checked) return false;
    const code = randomBytes(3).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    this.store.createPaneCloseRequest({
      id: randomUUID(), bindingId: checked.binding.id, paneId: checked.pane.paneId, actorOpenId: message.actorOpenId,
      codeHash: paneCloseCodeHash(code), expiresAt
    });
    await this.replyStandalone(message.rootMessageId ?? message.messageId, renderPaneCloseConfirmationCard({
      spaceName: this.spaceNameFor(checked.binding), paneId: checked.pane.paneId, agentState: checked.pane.agentState, code, expiresAt
    }));
    this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.requested", target: checked.binding.id, outcome: "confirmation_issued" });
    return true;
  }

  private async recoverPaneCloseOperations(): Promise<void> {
    for (const operation of this.store.listUnresolvedPaneCloseOperations()) {
      const binding = this.store.getBinding(operation.bindingId);
      if (binding?.lifecycle === "closed" && binding.paneId === operation.paneId) {
        this.store.finishPaneCloseRequest(operation.id, "succeeded", "binding was already closed before recovery");
        continue;
      }
      if (!binding || binding.paneId !== operation.paneId) {
        this.store.finishPaneCloseRequest(operation.id, "uncertain", "binding identity changed before recovery");
        continue;
      }
      try {
        const pane = await this.herdr.getPane(operation.paneId);
        if (pane) {
          this.store.finishPaneCloseRequest(operation.id, "uncertain", "pane still present after restart; close was not replayed");
          continue;
        }
        let next = this.store.transitionBinding(binding.id, { type: "archive_requested", hasActiveTurn: false });
        next = this.store.transitionBinding(next.id, { type: "closed" });
        this.store.finishPaneCloseRequest(operation.id, "succeeded", "pane absence verified after restart");
        await this.publish(next.id, "BindingArchived", "bridge", { reason: `Herdr pane ${operation.paneId} 的关闭结果已在 Bridge 重启后确认。` });
      } catch (error) {
        this.store.finishPaneCloseRequest(operation.id, "uncertain", `restart verification failed: ${errorMessage(error)}`);
      }
    }
  }

  private async confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean> {
    if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") {
      await this.reject(message, "这个话题没有可关闭的活动 Pane。");
      return false;
    }
    const outcome = this.store.consumePaneCloseRequest({
      bindingId: binding.id, paneId: binding.paneId, actorOpenId: message.actorOpenId,
      codeHash: paneCloseCodeHash(code), now: new Date().toISOString()
    });
    if (outcome.outcome !== "consumed") {
      const reason = outcome.outcome === "unauthorized" ? "只有发起关闭请求的用户可以确认。"
        : outcome.outcome === "expired" ? "确认码已过期，请重新发送 `/herdr pane close`。"
          : outcome.outcome === "stale" ? "没有待确认的关闭请求，请重新发送 `/herdr pane close`。"
            : "确认码无效。";
      await this.reject(message, reason);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: outcome.outcome });
      return false;
    }
    const checked = await this.checkPaneCloseSafety(message, this.store.getBinding(binding.id), outcome.paneId);
    if (!checked) { this.store.finishPaneCloseRequest(outcome.operationId, "rejected", "safety_recheck_failed"); return false; }
    try {
      await this.herdr.closePane(checked.pane.paneId);
      let next = this.store.transitionBinding(checked.binding.id, { type: "archive_requested", hasActiveTurn: false });
      next = this.store.transitionBinding(next.id, { type: "closed" });
      this.store.finishPaneCloseRequest(outcome.operationId, "succeeded");
      await this.publish(next.id, "BindingArchived", "lark", { reason: `Herdr pane ${checked.pane.paneId} 已由飞书确认关闭。` });
      await this.replyStandalone(message.rootMessageId ?? message.messageId, renderPaneCloseResultCard({ paneId: checked.pane.paneId }));
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.completed", target: checked.binding.id, outcome: "closed" });
      return true;
    } catch (error) {
      this.store.finishPaneCloseRequest(outcome.operationId, "uncertain", errorMessage(error));
      await this.reject(message, `Pane 关闭失败或无法验证：${errorMessage(error)}`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.failed", target: checked.binding.id, outcome: "unverified" });
      return false;
    }
  }

  private async checkPaneCloseSafety(message: IncomingLarkMessage, binding: Binding | null, expectedPaneId?: string): Promise<{ binding: Binding; pane: NonNullable<Awaited<ReturnType<HerdrPort["getPane"]>>> } | null> {
    if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") {
      await this.reject(message, "这个话题没有可关闭的活动 Pane。");
      return null;
    }
    if (expectedPaneId !== undefined && binding.paneId !== expectedPaneId) {
      await this.reject(message, "Pane identity 已变化，不能关闭。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" });
      return null;
    }
    if (this.promptRun.isBindingBusy(binding.id) || this.store.countPendingPrompts(binding.id) > 0) {
      await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，不能关闭。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "busy" });
      return null;
    }
    const pane = await this.herdr.getPane(binding.paneId);
    if (!pane) {
      const orphaned = this.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 1 });
      await this.publish(orphaned.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` });
      await this.reject(message, `Pane ${binding.paneId} 已不存在，绑定已标记为 orphaned。`);
      return null;
    }
    if (pane.workspaceId !== binding.workspaceId || binding.traexSessionId !== null && pane.terminalId !== binding.traexSessionId) {
      await this.reject(message, "Pane identity 已变化，不能关闭。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" });
      return null;
    }
    if (pane.agentState !== "idle" && pane.agentState !== "done") {
      await this.reject(message, `Pane 当前状态为 ${pane.agentState}，不能关闭；仅 idle/done 状态允许关闭。`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: pane.agentState });
      return null;
    }
    return { binding, pane };
  }

  async reconcile(): Promise<void> {
    await this.reconciler.reconcile();
  }

  private async createProjectSelector(message: IncomingLarkMessage, requestedTitle: string | null): Promise<void> {
    const selectionId = randomUUID();
    this.store.createProjectSelection({
      id: selectionId, commandMessageId: message.messageId, chatId: message.chatId, topicId: message.topicId,
      rootMessageId: message.rootMessageId ?? message.messageId, actorOpenId: message.actorOpenId, requestedTitle,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), card: renderProjectSelectorCard({ selectionId, projects: this.config.projects })
    });
    await this.channelPublisher.drain();
  }

  private async publishSpaceDirectory(message: IncomingLarkMessage): Promise<void> {
    const panesByWorkspace = new Map<string, Awaited<ReturnType<HerdrPort["listPanes"]>>>();
    const errorsByWorkspace = new Map<string, string>();
    for (const workspaceId of new Set(this.config.projects.map((project) => project.workspaceId))) {
      try {
        panesByWorkspace.set(workspaceId, await this.herdr.listPanes(workspaceId));
      } catch (error) {
        const safe = safeLogError(error);
        errorsByWorkspace.set(workspaceId, safe.message);
        this.logger.warn({ event: "space-directory-workspace-failed", err: safe, workspaceId, outcome: "partial" }, "workspace unavailable while building space directory");
      }
    }

    const groups = buildSpaceDirectoryGroups(this.config.projects, panesByWorkspace, errorsByWorkspace);
    const bindings = this.store.listBindings();
    for (const group of groups) for (const pane of group.panes) {
      const binding = selectSpaceDirectoryBinding(bindings, pane.paneId, message.chatId);
      if (binding) pane.bindingId = binding.id;
      const paneIsBound = bindings.some((candidate) => candidate.paneId === pane.paneId);
      if (!paneIsBound && !group.unregistered && pane.foregroundExecutables.includes("traex")) {
        const projects = this.config.projects.filter((project) => project.workspaceId === group.workspaceId && projectSpaceName(project) === group.spaceName && project.cwd === panesByWorkspace.get(group.workspaceId)?.find((candidate) => candidate.paneId === pane.paneId)?.cwd);
        if (projects.length === 1) pane.claimProjectId = projects[0]!.id;
      }
    }
    const cards = renderSpaceDirectoryCards(groups);
    const rootMessageId = message.rootMessageId ?? message.messageId;
    for (const [index, card] of cards.entries()) {
      await this.channelPublisher.enqueueCard(rootMessageId, `spaces:${message.messageId}:${index}`, card);
    }
  }

  private async publishOperationCards(message: IncomingLarkMessage, kind: string, cards: object[]): Promise<void> {
    const rootMessageId = message.rootMessageId ?? message.messageId;
    for (const [index, card] of cards.entries()) await this.channelPublisher.enqueueCard(rootMessageId, `${kind}:${message.messageId}:${index}`, card);
    this.logger.info({ event: `operation-${kind}-listed`, chatId: message.chatId, pageCount: cards.length, outcome: "listed" }, `listed Herdr ${kind}`);
  }

  private async createSelectedProject(
    selection: ReturnType<BindingStorePort["getProjectSelection"]> & {},
    project: ProjectConfig,
    allowPaneCreation: boolean
  ): Promise<Binding> {
    const bindingId = selection.bindingId ?? randomUUID();
    const paneTitle = selection.requestedTitle ?? randomPaneName();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    let binding = selection.bindingId ? this.store.getBinding(selection.bindingId) : null;
    if (!binding) {
      binding = this.store.createPendingBinding({ id: bindingId, projectId: project.id, workspaceId: project.workspaceId, chatId: selection.chatId, topicId: null, rootMessageId: null, title });
      this.store.linkProjectSelectionBinding(selection.id, binding.id);
      await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: null });
    }
    try {
      let pane = binding.paneId ? await this.herdr.getPane(binding.paneId) : null;
      if (binding.paneId && !pane) throw new Error(`Provisioned Herdr pane ${binding.paneId} no longer exists`);
      if (pane && binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${binding.paneId}`);
      if (binding.provisioningCheckpoint === "selected") {
        if (!allowPaneCreation) {
          throw new Error("Interrupted while creating the Herdr pane; inspect the Space and attach the surviving pane with /herdr attach <space> <pane>");
        }
        pane = await this.herdr.createPane(project.workspaceId, project.cwd, {
          bindingId: binding.id, generation: binding.generation, projectId: project.id, placement: "dedicated-tab", title: paneTitle
        });
        binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
        binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
      }
      if (!pane && binding.paneId) pane = await this.herdr.getPane(binding.paneId);
      if (!pane) throw new Error(`Provisioning checkpoint ${binding.provisioningCheckpoint} has no Herdr pane`);
      if (binding.provisioningCheckpoint === "pane_created") {
        await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
        binding = this.store.updateBinding(binding.id, { lastAgentState: "idle" });
        binding = this.store.transitionBinding(binding.id, { type: "runtime_started" });
      }
      const activatedEvent = this.event(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: "pending" });
      const activeView = reduceTopicView(this.store.loadTopicView(binding.id) ?? initialTopicView(binding.id), activatedEvent);
      if (binding.provisioningCheckpoint === "runtime_started") {
        const topic = await this.lark.createTopic(renderProjectEntryCard(activeView), binding.id);
        this.store.recordBridgeMessage(topic.rootMessageId);
        binding = this.store.updateBinding(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId });
        binding = this.store.transitionBinding(binding.id, { type: "thread_created" });
      }
      if (binding.provisioningCheckpoint === "thread_created") binding = this.store.transitionBinding(binding.id, { type: "activate" });
      await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: binding.topicId! });
      return binding;
    } catch (error) {
      this.logger.warn({ event: "project-provisioning-paused", err: safeLogError(error), selectionId: selection.id, bindingId: binding.id, checkpoint: binding.provisioningCheckpoint, outcome: "retry_on_restart" }, "project provisioning paused at a durable checkpoint");
      throw error;
    }
  }

  private async recoverProjectSelection(selection: NonNullable<ReturnType<BindingStorePort["getProjectSelection"]>>): Promise<void> {
    const project = selection.selectedProjectId ? this.config.projects.find((item) => item.id === selection.selectedProjectId) : null;
    if (!selection.bindingId || !project) {
      this.store.failProjectSelection(selection.id, "Interrupted before recoverable project identity was persisted");
      return;
    }
    try {
      const binding = await this.createSelectedProject(selection, project, false);
      this.store.completeProjectSelection(selection.id, binding.id);
      if (selection.selectorMessageId) await this.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding);
      this.logger.info({ event: "project-selection-recovered", selectionId: selection.id, bindingId: binding.id, paneId: binding.paneId, outcome: "completed" }, "resumed interrupted project provisioning");
    } catch (error) {
      this.store.pauseProjectSelection(selection.id, errorMessage(error));
      if (selection.selectorMessageId) {
        await this.channelPublisher.enqueueCardUpdate(null, selection.selectorMessageId, `selection:${selection.id}:recoverable`, renderProjectSelectionStatusCard({
          status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project), message: errorMessage(error)
        }));
      }
      this.logger.error({ event: "project-selection-recovery-failed", err: safeLogError(error), selectionId: selection.id, bindingId: selection.bindingId, outcome: "retry_on_restart" }, "project provisioning remains recoverable");
    }
  }

  private async recoverDiscoveredBinding(binding: Binding): Promise<void> {
    if (!binding.paneId || !binding.projectId) return;
    const project = this.config.projects.find((candidate) => candidate.id === binding.projectId);
    if (!project) return;
    try {
      const pane = await this.requireMatchingPane(binding, binding.paneId);
      const createdEvent = this.event(binding.id, "BindingCreated", "herdr", { title: binding.title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: pane.paneId });
      const view = reduceTopicView(this.store.loadTopicView(binding.id) ?? initialTopicView(binding.id), createdEvent);
      const topic = await this.lark.createTopic(renderProjectEntryCard(view), binding.id);
      this.store.recordBridgeMessage(topic.rootMessageId);
      let next = this.store.updateBinding(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId });
      next = this.store.transitionBinding(next.id, { type: "thread_created" });
      next = this.store.transitionBinding(next.id, { type: "activate" });
      await this.bus.publish(createdEvent);
      await this.publish(next.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: topic.topicId });
      this.logger.info({ event: "discovered-binding-recovered", bindingId: next.id, paneId: pane.paneId, outcome: "completed" }, "resumed interrupted discovered-pane provisioning");
    } catch (error) {
      this.logger.error({ event: "discovered-binding-recovery-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, outcome: "retry_on_restart" }, "discovered-pane provisioning remains recoverable");
    }
  }

  private async publishSelectionSuccess(selectionId: string, selectorMessageId: string, project: ProjectConfig, binding: Binding): Promise<void> {
    const pane = binding.paneId ? { paneId: binding.paneId } : {};
    const navigation = binding.rootMessageId ? { bindingId: binding.id } : {};
    await this.channelPublisher.enqueueCardUpdate(null, selectorMessageId, `selection:${selectionId}:completed`, renderProjectSelectionStatusCard({
      status: "completed", projectName: project.displayName, spaceName: projectSpaceName(project), ...navigation, ...pane
    }));
  }

  private async createFromLark(message: IncomingLarkMessage, title: string, initialPrompt: string | null): Promise<void> {
    const bindingId = randomUUID();
    const defaultProject = this.config.projects.find((project) => project.id === this.config.defaultProjectId) ?? this.config.projects[0]!;
    const paneTitle = title || randomPaneName();
    title = formatProjectPaneTitle(projectSpaceName(defaultProject), defaultProject.cwd, paneTitle, "TraeX pane");
    let binding = this.store.createPendingBinding({
      id: bindingId, projectId: defaultProject.id, workspaceId: defaultProject.workspaceId, chatId: message.chatId,
      topicId: message.topicId ?? message.messageId, rootMessageId: message.rootMessageId ?? message.messageId, title
    });
    await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(defaultProject), paneId: null });
    try {
      const pane = await this.herdr.createPane(binding.workspaceId, defaultProject.cwd, {
        bindingId: binding.id, generation: binding.generation, projectId: defaultProject.id, placement: "dedicated-tab", title: paneTitle
      });
      binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
      binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
      await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
      binding = this.store.updateBinding(binding.id, { lastAgentState: "idle" });
      binding = this.store.transitionBinding(binding.id, { type: "runtime_started" });
      binding = this.store.transitionBinding(binding.id, { type: "thread_created" });
      binding = this.store.transitionBinding(binding.id, { type: "activate" });
      await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: binding.topicId! });
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
      if (initialPrompt) await this.enqueue(binding, message, initialPrompt);
    } catch (error) {
      this.store.updateBinding(binding.id, { state: "failed" });
      await this.publish(binding.id, "TurnFailed", "bridge", { promptId: message.messageId, error: errorMessage(error), queueDepth: 0 });
      throw error;
    }
  }

  private async createFromHerdr(pane: Awaited<ReturnType<HerdrPort["listPanes"]>>[number], project: ProjectConfig): Promise<Binding> {
    const id = randomUUID();
    const title = formatProjectPaneTitle(projectSpaceName(project), pane.cwd, pane.label, pane.paneId);
    let binding = this.store.createPendingBinding({ id, projectId: project.id, workspaceId: pane.workspaceId, chatId: this.config.lark.chatId, topicId: null, rootMessageId: null, title });
    binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
    binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
    binding = this.store.transitionBinding(binding.id, { type: "runtime_started" });
    const createdEvent = this.event(binding.id, "BindingCreated", "herdr", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: pane.paneId });
    const initialView = reduceTopicView(initialTopicView(binding.id), createdEvent);
    this.store.saveTopicView(initialView);
    const topic = await this.lark.createTopic(renderProjectEntryCard(initialView), binding.id);
    this.store.recordBridgeMessage(topic.rootMessageId);
    binding = this.store.updateBinding(binding.id, {
      topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId
    });
    binding = this.store.transitionBinding(binding.id, { type: "thread_created" });
    binding = this.store.transitionBinding(binding.id, { type: "activate" });
    await this.bus.publish(createdEvent);
    await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: topic.topicId });
    return binding;
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text, forcedParentPromptId?: string): Promise<void> {
    if (!forcedParentPromptId && this.store.countPendingPrompts(binding.id) >= this.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID();
    const occurredAt = new Date().toISOString();
    const activeRun = this.promptRun.activeTurn(binding.id);
    const parentPromptId = forcedParentPromptId ?? (activeRun?.state === "working" ? activeRun.promptId : null);
    const dispatchKind = parentPromptId ? "steering" as const : "turn" as const;
    const view = createQueuedRunCard({
      promptId, bindingId: binding.id, title: requestTitle(body), workspaceId: binding.workspaceId, paneId: binding.paneId,
      spaceName: this.spaceNameFor(binding), requestText: body, queuePosition: dispatchKind === "steering" ? 0 : this.store.countPendingPrompts(binding.id) + 1, occurredAt
    });
    const { prompt, inserted } = this.store.acceptPrompt({
      prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body, dispatchKind, parentPromptId },
      view, rootMessageId: binding.rootMessageId, answerCard: renderRequestAnswerCard(view)
    });
    if (!inserted) {
      await this.channelPublisher.drain();
      if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId });
      else this.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return;
    }
    const depth = this.store.countPendingPrompts(binding.id);
    this.logger.info({ event: "prompt-dispatch-decided", eventId: message.eventId, messageId: message.messageId, bindingId: binding.id, promptId: prompt.id, parentPromptId, workspaceId: binding.workspaceId, paneId: binding.paneId, dispatchKind, queueDepth: depth, outcome: inserted ? "accepted" : "duplicate" }, "accepted Lark prompt dispatch decision");
    if (dispatchKind === "steering" && parentPromptId) {
      await this.publish(binding.id, "SteeringQueued", "lark", { promptId: prompt.id, parentPromptId, actorOpenId: message.actorOpenId });
    } else {
      await this.publish(binding.id, "PromptQueued", "lark", { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    }
    this.store.audit({ actorOpenId: message.actorOpenId, action: dispatchKind === "steering" ? "prompt.steer" : "prompt.queue", target: binding.id, outcome: "success" });
    await this.channelPublisher.drain();
    if (dispatchKind === "steering" && parentPromptId) this.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId });
    else this.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  }

  private async stopActiveTurn(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding || binding.state !== "active" || binding.lifecycle !== "active") {
      await this.reject(message, "当前话题没有可停止的活动任务。`/stop` 未进入任务队列。");
      return false;
    }
    const activeRun = this.promptRun.activeTurn(binding.id);
    if (!activeRun || activeRun.state !== "working") {
      await this.reject(message, "当前没有确认处于 working 的 TraeX 任务。`/stop` 未进入任务队列。");
      return false;
    }
    await this.enqueue(binding, message, "/stop", activeRun.promptId);
    return true;
  }

  private async emitState(binding: Binding, state: Binding["lastAgentState"]): Promise<void> {
    await this.publish(binding.id, "AgentStateChanged", "bridge", { state, queueDepth: this.store.countPendingPrompts(binding.id) });
  }

  private async transitionAndPublish(binding: Binding, transition: import("../domain/pane-thread-lifecycle.js").SessionTransition, type: "BindingDraining" | "BindingArchived", origin: EventOrigin, payload: { reason: string }): Promise<Binding> {
    const event = this.event(binding.id, type, origin, payload) as Extract<BridgeEvent, { type: "BindingDraining" | "BindingArchived" }>;
    const current = this.store.loadTopicView(binding.id) ?? initialTopicView(binding.id);
    const view = reduceTopicView(current, event);
    if (!binding.statusMessageId) {
      const next = this.store.transitionBinding(binding.id, transition);
      await this.bus.publish(event);
      return next;
    }
    const next = this.store.transitionBindingWithOutbox({ id: binding.id, transition, event, view, messageId: binding.statusMessageId, card: renderProjectEntryCard(view) });
    await this.bus.publish(event);
    await this.channelPublisher.drain();
    return next;
  }

  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> {
    await this.channelPublisher.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason));
  }

  private async runModelCommand(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean> {
    const target = name ?? "list";
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") {
      await this.reject(message, "这个话题没有可切换模型的活动 TraeX Pane。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "inactive_binding" });
      return false;
    }
    if (this.promptRun.isBindingBusy(binding.id) || this.store.countPendingPrompts(binding.id) > 0 || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") {
      await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，请在当前任务或队列完成后重试。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "busy" });
      return false;
    }
    if (!this.herdr.runPaneCommand) {
      await this.reject(message, "当前 Herdr adapter 不支持模型切换。");
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "unsupported" });
      return false;
    }
    try {
      const pane = await this.requireMatchingPane(binding, binding.paneId);
      if (name) {
        if (!this.herdr.selectPaneModel) throw new Error("当前 Herdr adapter 不支持交互式模型选择。");
        await this.herdr.selectPaneModel(pane.paneId, name, this.config.commandTimeoutMs);
      }
      const output = await this.herdr.runPaneCommand(pane.paneId, "/model", this.config.commandTimeoutMs);
      await this.replyStandalone(message.rootMessageId ?? message.messageId, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: name !== null }));
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: name ? "switch_completed" : "list_completed" });
      return true;
    } catch (error) {
      await this.reject(message, `模型命令执行失败：${errorMessage(error)}`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "failed" });
      return false;
    }
  }

  private async runModelSelection(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void> {
    const binding = this.store.getBinding(bindingId);
    if (!binding?.paneId || binding.chatId !== action.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    if (this.promptRun.isBindingBusy(binding.id) || this.store.countPendingPrompts(binding.id) > 0 || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") return;
    if (!this.herdr.selectPaneModel || !this.herdr.runPaneCommand) return;
    try {
      const pane = await this.requireMatchingPane(binding, binding.paneId);
      await this.herdr.selectPaneModel(pane.paneId, model, this.config.commandTimeoutMs);
      const output = await this.herdr.runPaneCommand(pane.paneId, "/model", this.config.commandTimeoutMs);
      await this.channelPublisher.enqueueCardUpdate(binding.id, action.messageId, `model:${binding.id}:${model}`, renderModelResultCard({
        bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: true
      }));
      this.store.audit({ actorOpenId: action.operatorOpenId, action: "model.select", target: model, outcome: "switch_completed" });
    } catch (error) {
      this.logger.warn({ event: "model-selection-failed", err: safeLogError(error), bindingId, paneId: binding.paneId, outcome: "failed" }, "failed to select TraeX model");
      this.store.audit({ actorOpenId: action.operatorOpenId, action: "model.select", target: model, outcome: "failed" });
    }
  }

  private async attachExistingPane(message: IncomingLarkMessage, spaceName: string, paneReference: string): Promise<boolean> {
    const projects = this.config.projects.filter((project) => project.spaceName === spaceName);
    if (projects.length !== 1) {
      const reason = projects.length === 0 ? `未找到空间 ${spaceName}。` : `空间 ${spaceName} 对应多个项目，无法确定要连接哪一个。`;
      await this.reject(message, reason);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: projects.length === 0 ? "unknown_space" : "ambiguous_space" });
      return false;
    }

    const project = projects[0]!;
    const panes = (await this.herdr.listPanes(project.workspaceId, { forceRefresh: true })).filter((candidate) => candidate.workspaceId === project.workspaceId);
    const exactId = panes.find((candidate) => candidate.paneId === paneReference);
    const labelMatches = exactId ? [] : panes.filter((candidate) => candidate.label === paneReference);
    if (!exactId && labelMatches.length > 1) {
      const paneIds = labelMatches.map((candidate) => candidate.paneId).sort().join(", ");
      await this.reject(message, `Pane 名称 ${paneReference} 不唯一，请改用 Pane ID：${paneIds}`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_label" });
      return false;
    }
    const pane = exactId ?? labelMatches[0];
    if (!pane) {
      await this.reject(message, `在空间 ${spaceName} 的 Herdr workspace ${project.workspaceId} 中未找到 Pane ${paneReference}。`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "pane_not_found" });
      return false;
    }

    const existing = this.store.findBindingByPane(pane.paneId);
    if (existing) {
      if (this.isRecoverableFailedReset(existing, message, project)) {
        const recovered = await this.recoverFailedResetBinding(existing, pane);
        await this.publishAttachSuccess(message, recovered, spaceName, false);
        this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" });
        return true;
      }
      if (existing.chatId === this.config.lark.chatId && existing.projectId === project.id && existing.state === "active") {
        await this.publishAttachSuccess(message, existing, spaceName, true);
        this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "already_attached" });
        return true;
      }
      await this.reject(message, `Pane ${pane.paneId} 已绑定到其他会话，不能在这里重新连接。`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "bound_elsewhere" });
      return false;
    }

    if (!pane.foregroundExecutables.includes("traex")) {
      await this.reject(message, `Pane ${pane.paneId} 当前没有运行 TraeX，未执行连接。`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: pane.paneId, outcome: "traex_not_running" });
      return false;
    }

    const topicBinding = this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (topicBinding && this.isRecoverableFailedReset(topicBinding, message, project)) {
      const recovered = await this.recoverFailedResetBinding(topicBinding, pane);
      await this.publishAttachSuccess(message, recovered, spaceName, false);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" });
      return true;
    }

    const interruptedSelections = this.store.listProcessingProjectSelections().filter((selection) => {
      if (!selection.bindingId || selection.selectedProjectId !== project.id) return false;
      const binding = this.store.getBinding(selection.bindingId);
      return binding?.lifecycle === "provisioning" && binding.provisioningCheckpoint === "selected";
    });
    if (interruptedSelections.length === 1) {
      const selection = interruptedSelections[0]!;
      let binding = this.store.updateBinding(selection.bindingId!, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
      binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
      binding = await this.createSelectedProject(selection, project, false);
      this.store.completeProjectSelection(selection.id, binding.id);
      if (selection.selectorMessageId) await this.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding);
      await this.publishAttachSuccess(message, binding, spaceName, false);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "recovered_provisioning" });
      return true;
    }

    await this.createFromHerdr(pane, project);
    const binding = this.store.findBindingByPane(pane.paneId);
    if (binding) await this.publishAttachSuccess(message, binding, spaceName, false);
    this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding?.id ?? pane.paneId, outcome: "success" });
    return true;
  }

  private isRecoverableFailedReset(binding: Binding, message: IncomingLarkMessage, project: ProjectConfig): boolean {
    return binding.state === "failed"
      && binding.projectId === project.id
      && binding.chatId === message.chatId
      && binding.topicId === message.topicId
      && binding.rootMessageId === message.rootMessageId;
  }

  private async recoverFailedResetBinding(binding: Binding, pane: import("../domain/types.js").HerdrPane): Promise<Binding> {
    if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${pane.paneId}`);
    const recovered = this.store.updateBinding(binding.id, {
      paneId: pane.paneId, traexSessionId: pane.terminalId ?? null, state: "active", lifecycle: "active", attachment: "attached",
      provisioningCheckpoint: "activated", lastAgentState: pane.agentState, statusMessageId: binding.rootMessageId
    });
    await this.publish(recovered.id, "BindingActivated", "lark", { paneId: pane.paneId, topicId: recovered.topicId! });
    return recovered;
  }

  private async publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean): Promise<void> {
    if (!binding.paneId) return;
    const bindingId = binding.rootMessageId ? binding.id : undefined;
    await this.channelPublisher.enqueueCard(
      message.rootMessageId ?? message.messageId,
      `attach:${message.messageId}:${alreadyAttached ? "existing" : "created"}`,
      renderAttachStatusCard({ spaceName, paneId: binding.paneId, ...(bindingId ? { bindingId } : {}), alreadyAttached })
    );
  }

  private async requireMatchingPane(binding: Binding, paneId: string) {
    const pane = (await this.herdr.observeRuntime(paneId)).pane;
    if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
    if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`);
    const project = this.config.projects.find((item) => item.id === binding.projectId);
    if (project && pane.cwd !== project.cwd) throw new Error(`Herdr pane ${paneId} does not match project ${project.displayName}`);
    if (binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${paneId}`);
    if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${paneId}`);
    return pane;
  }

  private async reattachBinding(binding: Binding, paneId: string, replacement: boolean, actorOpenId: string): Promise<void> {
    const pane = await this.requireMatchingPane(binding, paneId);
    if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
    const next = this.store.attachBindingPane(binding.id, pane, replacement);
    await this.publish(next.id, "BindingArchived", "lark", { reason: "Pane 已验证并连接；为避免重放不确定任务，发送 `/herdr resume` 后才继续队列。" });
    this.store.audit({ actorOpenId, action: replacement ? "binding.replace" : "binding.reattach", target: binding.id, outcome: "success" });
  }

  private async replaceBinding(binding: Binding, actorOpenId: string): Promise<void> {
    const project = this.config.projects.find((item) => item.id === binding.projectId);
    if (!project) throw new Error(`Project configuration missing for binding ${binding.id}`);
    const existingPane = binding.paneId ? await this.herdr.getPane(binding.paneId) : null;
    const paneTitle = existingPane?.label?.trim() || binding.title.split(" / ").at(-1) || project.displayName;
    const pane = await this.herdr.createPane(project.workspaceId, project.cwd, {
      bindingId: binding.id, generation: binding.generation + 1, projectId: project.id, placement: "dedicated-tab", title: paneTitle
    });
    await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
    const next = this.store.updateBinding(this.store.attachBindingPane(binding.id, pane, true).id, { lastAgentState: "idle" });
    await this.publish(next.id, "BindingArchived", "lark", { reason: "Replacement Pane 已创建；为避免重放不确定任务，发送 `/herdr resume` 后才继续队列。" });
    this.store.audit({ actorOpenId, action: "binding.replace", target: binding.id, outcome: "success" });
  }

  private spaceNameFor(binding: Binding): string {
    const matches = binding.projectId
      ? this.config.projects.filter((project) => project.id === binding.projectId)
      : this.config.projects.filter((project) => project.workspaceId === binding.workspaceId);
    return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved";
  }

  private async replyStandalone(rootMessageId: string, card: object): Promise<void> {
    await this.channelPublisher.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card);
  }

  private event<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): BridgeEventOf<T> {
    return createBridgeEvent<T>(bindingId, type, origin, payload);
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> {
    await this.bus.publish(createBridgeEvent<T>(bindingId, type, origin, payload));
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function paneCloseCodeHash(code: string): string { return createHash("sha256").update(code.trim().toUpperCase()).digest("hex"); }
function randomPaneName(): string {
  const suffix = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4);
  return `task-${suffix}`;
}
export function buildSpaceDirectoryGroups(
  projects: readonly ProjectConfig[],
  panesByWorkspace: ReadonlyMap<string, Awaited<ReturnType<HerdrPort["listPanes"]>>>,
  errorsByWorkspace: ReadonlyMap<string, string>
): SpaceDirectoryGroup[] {
  const groups = new Map<string, SpaceDirectoryGroup>();
  for (const project of projects) {
    const spaceName = projectSpaceName(project);
    const key = `${project.workspaceId}\0${spaceName}`;
    const group = groups.get(key) ?? { spaceName, workspaceId: project.workspaceId, directories: [], panes: [] };
    if (!group.directories.includes(project.cwd)) group.directories.push(project.cwd);
    const error = errorsByWorkspace.get(project.workspaceId);
    if (error) group.error = error;
    groups.set(key, group);
  }

  const result = [...groups.values()];
  for (const [workspaceId, panes] of panesByWorkspace) {
    const workspaceGroups = result.filter((group) => group.workspaceId === workspaceId);
    const unmatched = [];
    for (const pane of panes) {
      const group = workspaceGroups.find((candidate) => pane.cwd !== null && candidate.directories.includes(pane.cwd));
      const view = { paneId: pane.paneId, name: pane.label ?? pane.paneId, agentState: pane.agentState, foregroundExecutables: pane.foregroundExecutables };
      if (group) group.panes.push(view);
      else unmatched.push(view);
    }
    if (unmatched.length) result.push({ spaceName: "未注册", workspaceId, directories: [], panes: unmatched, unregistered: true });
  }
  return result;
}

type SpaceDirectoryBindingCandidate = Pick<Binding, "id" | "paneId" | "chatId" | "topicId" | "rootMessageId" | "lifecycle" | "updatedAt">;

export function selectSpaceDirectoryBinding(
  bindings: readonly SpaceDirectoryBindingCandidate[],
  paneId: string,
  chatId: string
): SpaceDirectoryBindingCandidate | null {
  const lifecycleRank: Partial<Record<Binding["lifecycle"], number>> = { active: 0, draining: 1, archived: 2 };
  return bindings
    .filter((binding) =>
      binding.paneId === paneId &&
      binding.chatId === chatId &&
      Boolean(binding.topicId ?? binding.rootMessageId) &&
      lifecycleRank[binding.lifecycle] !== undefined
    )
    .sort((left, right) =>
      lifecycleRank[left.lifecycle]! - lifecycleRank[right.lifecycle]! ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    )[0] ?? null;
}
function provisioningRecoveryMessage(error: unknown): string {
  const detail = errorMessage(error);
  return detail.includes("/herdr attach")
    ? `创建结果无法自动确认。请先检查对应 Space：若 Pane 已存在，发送 \`/herdr attach <space> <pane>\`；若不存在，再发送 \`/herdr new\`。${detail}`
    : `创建已停在可恢复检查点，bridge 会安全重试。${detail}`;
}
function parseOpenThreadAction(value: unknown): { bindingId: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== "open_project_thread" || typeof candidate.bindingId !== "string") return null;
  return { bindingId: candidate.bindingId };
}
function parseModelSelectionAction(value: unknown, option?: string | null): { bindingId: string; model: string } | null {
  if (!value || typeof value !== "object" || !option) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== "select_model" || typeof candidate.bindingId !== "string") return null;
  if (!/^[a-z0-9][a-z0-9._:+/-]{0,127}$/i.test(option)) return null;
  return { bindingId: candidate.bindingId, model: option };
}
function parseDeadLetterAction(value: unknown): { action: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if ((candidate.action !== "retry_dead_letter" && candidate.action !== "dismiss_dead_letter") || typeof candidate.replyId !== "string") return null;
  return { action: candidate.action, replyId: candidate.replyId };
}
function parsePaneClaimAction(value: unknown): { projectId: string; workspaceId: string; paneId: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== "claim_pane" || typeof candidate.projectId !== "string" || typeof candidate.workspaceId !== "string" || typeof candidate.paneId !== "string") return null;
  return { projectId: candidate.projectId, workspaceId: candidate.workspaceId, paneId: candidate.paneId };
}
function parseProjectAction(value: unknown): { selectionId: string; projectId: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== "select_project" || typeof candidate.selectionId !== "string" || typeof candidate.projectId !== "string") return null;
  return { selectionId: candidate.selectionId, projectId: candidate.projectId };
}
function requestTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " " ).trim();
  return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request";
}
