import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderAttachStatusCard, renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderProjectEntryCard, renderProjectSelectionStatusCard, renderProjectSelectorCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { renderSpaceDirectoryCards, type SpaceDirectoryGroup } from "../cards/space-directory-card.js";
import { renderFailureCards, renderSessionCards } from "../cards/operations-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { renderModelResultCard } from "../cards/model-card.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import { initialTopicView, mirrorRunCardToTopic, reduceTopicView } from "../domain/topic-view.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, EventOrigin, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import type { BridgeEventBus } from "../events/bridge-event-bus.js";
import type { LarkChannelPublisher } from "../events/lark-channel-publisher.js";
import { cleanTerminalOutput, outputFingerprint } from "../runtime/output.js";
import { extractFinalTraexAnswer, parseTerminalStreamDelta } from "../runtime/traex-output-parser.js";
import { safeLogError } from "../runtime/safe-error.js";

export class SyncCoordinator {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, { promptId: string; paneId: string; state: Binding["lastAgentState"]; abortController: AbortController }>();
  private readonly steeringWorkers = new Map<string, Promise<void>>();
  private readonly observedAgentStates = new Map<string, Binding["lastAgentState"]>();
  private readonly observedTerminalOutputs = new Map<string, string>();
  private skippedPaneReasons = new Map<string, string>();
  private reconciliation: Promise<void> | null = null;
  private inboundDrain: Promise<void> | null = null;
  private stopping = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopInboundSubscription: (() => void) | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStorePort,
    private readonly herdr: HerdrPort,
    private readonly lark: LarkPort,
    private readonly bus: BridgeEventBus,
    private readonly channelPublisher: LarkChannelPublisher,
    private readonly logger: Logger,
    private readonly shutdownGraceMs = 30_000
  ) {}

  async start(): Promise<void> {
    const recovered = this.store.recoverRunningPrompts();
    if (recovered > 0) this.logger.warn({ event: "startup-prompts-recovered", recovered, outcome: "failed_without_replay" }, "marked interrupted prompt jobs as failed without replay");
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
    await this.captureOutputBaselines();
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      if (this.stopping) return;
      void this.reconcile().catch((error) => this.logger.error({ event: "reconciliation-failed", err: safeLogError(error), outcome: "failed" }, "reconciliation failed"));
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();
    this.stopInboundSubscription = this.bus.onInboundMessage((event) => this.acceptInboundMessage(event.payload));
    await this.lark.start((message) => this.handleMessage(message), (action) => this.handleCardAction(action));
    for (const selection of recoverableSelections) await this.recoverProjectSelection(selection);
    const selectionBindingIds = new Set(recoverableSelections.flatMap((selection) => selection.bindingId ? [selection.bindingId] : []));
    for (const binding of this.store.listBindings().filter((candidate) =>
      candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "runtime_started" && !selectionBindingIds.has(candidate.id)
    )) await this.recoverDiscoveredBinding(binding);
    await this.channelPublisher.drain();
    await this.drainInboundMessages();
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) this.scheduleWorker(binding.id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.lark.stop();
    this.stopInboundSubscription?.();
    const pending = [
      ...this.workers.values(),
      ...this.steeringWorkers.values(),
      ...(this.reconciliation ? [this.reconciliation] : []),
      ...(this.inboundDrain ? [this.inboundDrain] : [])
    ];
    if (!pending.length) return;
    const settled = Promise.allSettled(pending);
    const graceful = await settlesWithin(settled, this.shutdownGraceMs);
    if (!graceful) {
      this.logger.warn({ event: "bridge-shutdown-turns-aborted", activeTurns: this.activeRuns.size, graceMs: this.shutdownGraceMs, outcome: "aborted" }, "aborting Bridge prompt waiters after shutdown grace period");
      for (const run of this.activeRuns.values()) run.abortController.abort();
      await settled;
    }
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
    const openThread = parseOpenThreadAction(action.value);
    if (openThread) {
      const binding = this.store.listBindings().find((item) => item.id === openThread.bindingId);
      if (!binding || binding.chatId !== action.chatId) return;
      const topicOrRootMessageId = binding.topicId ?? binding.rootMessageId;
      if (!topicOrRootMessageId) return;
      await this.lark.shareThread(topicOrRootMessageId, action.chatId);
      this.store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "shared" });
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
      const binding = selection.bindingId ? this.store.listBindings().find((item) => item.id === selection.bindingId) : null;
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
        await this.bus.publishInbound({
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
      } else if (command?.kind === "model") {
        disposition = await this.runModelCommand(message, binding, command.name) ? "command_completed" : "rejected";
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
          await this.herdr.renamePane(binding.paneId, command.title);
          this.store.updateBinding(binding.id, { title });
          await this.publish(binding.id, "BindingRenamed", "lark", { title });
          this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.rename", target: binding.id, outcome: "success" });
        }
      } else if (command?.kind === "close") {
        if (!binding || binding.lifecycle !== "active") {
          await this.channelPublisher.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard("这个话题没有可归档的活动会话。"));
          disposition = "rejected";
        } else await this.archiveBinding(binding, message.actorOpenId);
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
          this.scheduleWorker(binding.id);
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
    const hasActiveTurn = this.activeRuns.has(binding.id) || this.workers.has(binding.id) && binding.lastAgentState === "working";
    const reason = hasActiveTurn ? "停止接收新消息；当前任务完成后归档。" : "已从飞书归档；Herdr pane 与 TraeX 保持运行。";
    for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "queued")) {
      await this.publish(binding.id, "PromptCancelled", "bridge", { promptId: view.promptId, reason: "话题已归档，排队任务已取消。" });
    }
    this.store.cancelQueuedPrompts(binding.id, "话题已归档，排队任务已取消。");
    const type = hasActiveTurn ? "BindingDraining" as const : "BindingArchived" as const;
    const next = await this.transitionAndPublish(binding, { type: "archive_requested", hasActiveTurn }, type, "lark", { reason });
    this.store.audit({ actorOpenId, action: "binding.archive", target: binding.id, outcome: next.lifecycle });
  }

  async reconcile(): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation) return this.reconciliation;
    const work = this.reconcileOnce();
    this.reconciliation = work;
    try { await work; }
    finally { if (this.reconciliation === work) this.reconciliation = null; }
  }

  private async reconcileOnce(): Promise<void> {
    await this.channelPublisher.drain();
    const panesByWorkspace = new Map<string, Awaited<ReturnType<HerdrPort["listPanes"]>>>();
    for (const workspaceId of new Set(this.config.projects.map((project) => project.workspaceId))) {
      try {
        panesByWorkspace.set(workspaceId, await this.herdr.listPanes(workspaceId));
      } catch (error) {
        this.logger.error({ event: "workspace-reconciliation-failed", err: safeLogError(error), workspaceId, outcome: "failed" }, "workspace reconciliation failed");
      }
    }
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) {
      const workspacePanes = panesByWorkspace.get(binding.workspaceId);
      if (!workspacePanes) {
        const next = this.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
        this.logger.warn({ event: "binding-pane-probe-failed", bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, degradationCount: next.degradationCount, outcome: next.attachment, reason: "workspace_unavailable" }, "could not observe binding because its workspace was unavailable");
        if (next.attachment === "orphaned") await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Herdr workspace ${binding.workspaceId} remained unavailable` });
        continue;
      }
      const paneIds = new Set(workspacePanes.map((pane) => pane.paneId));
      if (binding.paneId && !paneIds.has(binding.paneId)) {
        this.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
        const occurredAt = new Date().toISOString();
        for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "running" || item.phase === "blocked")) {
          const next = { ...view, phase: "failed" as const, notice: `Herdr pane ${binding.paneId} no longer exists`, finishedAt: occurredAt, queuePosition: 0, viewVersion: view.viewVersion + 1, updatedAt: occurredAt };
          this.store.saveRunCard(next);
          if (!next.answerCardId && next.answerMessageId) await this.channelPublisher.enqueueRunCardUpdate(next.bindingId, next.promptId, next.answerMessageId, next.viewVersion, "answer", renderRequestAnswerCard(next));
        }
        for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "queued")) {
          const next = { ...view, phase: "blocked" as const, notice: `Herdr pane ${binding.paneId} no longer exists，请恢复绑定后重试。`, viewVersion: view.viewVersion + 1, updatedAt: occurredAt };
          this.store.saveRunCard(next);
          if (!next.answerCardId && next.answerMessageId) await this.channelPublisher.enqueueRunCardUpdate(next.bindingId, next.promptId, next.answerMessageId, next.viewVersion, "answer", renderRequestAnswerCard(next));
        }
        await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` });
      }
    }

    const nextSkippedPaneReasons = new Map<string, string>();
    for (const [requestedWorkspaceId, panes] of panesByWorkspace) for (const pane of panes) {
      if (pane.workspaceId !== requestedWorkspaceId) {
        this.logger.warn({ event: "herdr-pane-skipped", requestedWorkspaceId, reportedWorkspaceId: pane.workspaceId, paneId: pane.paneId, reason: "workspace_mismatch" }, "skipping pane returned for the wrong workspace");
        continue;
      }
      if (!pane.foregroundExecutables.includes("traex")) continue;
      const existing = this.store.findBindingByPane(pane.paneId);
      if (!existing) {
        const projects = this.config.projects.filter((project) => project.workspaceId === pane.workspaceId && project.cwd === pane.cwd);
        if (projects.length !== 1) {
          const reason = projects.length === 0 ? "unregistered" : "ambiguous";
          const signature = `${reason}:${projects.map((project) => project.id).sort().join(",")}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) {
            this.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, matchingProjects: projects.map((project) => project.id), reason }, "skipping unregistered or ambiguous Herdr pane");
          }
          continue;
        }
        const interruptedProvisioning = this.store.listBindings().find((candidate) =>
          candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "selected" && candidate.projectId === projects[0]!.id
        );
        if (interruptedProvisioning) {
          const signature = `provisioning:${interruptedProvisioning.id}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) {
            this.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, bindingId: interruptedProvisioning.id, reason: "ambiguous_interrupted_provisioning" }, "leaving pane unclaimed until interrupted provisioning is resolved explicitly");
          }
          continue;
        }
        if (this.skippedPaneReasons.has(pane.paneId)) {
          this.logger.info({ event: "herdr-pane-skip-resolved", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, outcome: "registered" }, "previously skipped Herdr pane now matches a project");
        }
        await this.createFromHerdr(pane, projects[0]!);
        const output = cleanTerminalOutput(await this.herdr.readOutput(pane.paneId, 240));
        this.observedTerminalOutputs.set(pane.paneId, output);
        this.observedAgentStates.set(pane.paneId, pane.agentState);
        continue;
      }
      if (!existing.projectId) {
        const projects = this.config.projects.filter((project) => project.workspaceId === pane.workspaceId && project.cwd === pane.cwd);
        if (projects.length === 1) this.store.updateBinding(existing.id, { projectId: projects[0]!.id });
      }
      // Provisioning recovery validates the persisted pane identity at its checkpoint.
      // Normal reconciliation must not transition an incomplete saga first.
      if (existing.lifecycle === "provisioning") continue;
      const previous = this.observedAgentStates.get(pane.paneId) ?? existing.lastAgentState;
      if (existing.traexSessionId && pane.terminalId && existing.traexSessionId !== pane.terminalId) {
        this.store.transitionBinding(existing.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
        await this.publish(existing.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${pane.paneId} terminal identity changed` });
        continue;
      }
      if (existing.attachment !== "orphaned" && (existing.lifecycle === "active" || existing.lifecycle === "draining")) {
        this.store.transitionBinding(existing.id, { type: "pane_observed", runtime: pane.agentState });
      }
      this.observedAgentStates.set(pane.paneId, pane.agentState);
      if (existing.state !== "active" || this.workers.has(existing.id)) continue;
      if (previous !== pane.agentState) {
        this.store.updateBinding(existing.id, { lastAgentState: pane.agentState });
        await this.publish(existing.id, "AgentStateChanged", "herdr", {
          state: pane.agentState, queueDepth: this.store.countPendingPrompts(existing.id)
        });
      }
      if (previous === "blocked" && pane.agentState !== "blocked" && this.store.countPendingPrompts(existing.id) > 0) {
        this.scheduleWorker(existing.id);
      }
      if (previous === "working" && (pane.agentState === "done" || pane.agentState === "idle")) {
        await this.publishChangedLocalOutput(existing, pane.paneId);
      } else {
        await this.publishChangedLocalOutput(existing, pane.paneId);
      }
    }
    this.skippedPaneReasons = nextSkippedPaneReasons;
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) this.scheduleWorker(binding.id);
  }

  private async captureOutputBaselines(): Promise<void> {
    for (const binding of this.store.listBindings().filter((item) => item.state === "active" && item.paneId)) {
      try {
        const output = cleanTerminalOutput(await this.herdr.readOutput(binding.paneId!, 240));
        this.observedTerminalOutputs.set(binding.paneId!, output);
        if (output) this.store.updateBinding(binding.id, { lastOutputFingerprint: outputFingerprint(output) });
      } catch (error) {
        const next = this.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: isPaneMissing(error), orphanThreshold: 2 });
        if (next.attachment === "orphaned") await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Unable to read Herdr pane ${binding.paneId}: ${errorMessage(error)}` });
        this.logger.warn({ event: "binding-pane-probe-failed", err: safeLogError(error), bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, degradationCount: next.degradationCount, outcome: next.attachment }, "failed to observe Herdr pane during startup");
      }
    }
  }

  private async publishChangedLocalOutput(binding: Binding, paneId: string): Promise<void> {
    const output = cleanTerminalOutput(await this.herdr.readOutput(paneId, 240));
    if (!output) return;
    const previous = this.observedTerminalOutputs.get(paneId) ?? "";
    this.observedTerminalOutputs.set(paneId, output);
    const fingerprint = outputFingerprint(output);
    if (fingerprint === binding.lastOutputFingerprint) return;
    this.store.updateBinding(binding.id, { lastOutputFingerprint: fingerprint });
    const answer = extractTraexAnswer(extractNewOutput(previous, output));
    if (!answer) return;
    await this.publish(binding.id, "TurnCompleted", "herdr", {
      promptId: `local:${fingerprint.slice(0, 16)}`, answer, queueDepth: this.store.countPendingPrompts(binding.id)
    });
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
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, selection.requestedTitle ?? project.displayName, "TraeX pane");
    let binding = selection.bindingId ? this.store.listBindings().find((item) => item.id === selection.bindingId) : null;
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
        pane = await this.herdr.createPane(project.workspaceId, project.cwd, { bindingId: binding.id, generation: binding.generation, projectId: project.id });
        binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
        binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
      }
      if (!pane && binding.paneId) pane = await this.herdr.getPane(binding.paneId);
      if (!pane) throw new Error(`Provisioning checkpoint ${binding.provisioningCheckpoint} has no Herdr pane`);
      if (binding.provisioningCheckpoint === "pane_created") {
        await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
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
    title = formatProjectPaneTitle(projectSpaceName(defaultProject), defaultProject.cwd, title, "TraeX pane");
    let binding = this.store.createPendingBinding({
      id: bindingId, projectId: defaultProject.id, workspaceId: defaultProject.workspaceId, chatId: message.chatId,
      topicId: message.topicId ?? message.messageId, rootMessageId: message.rootMessageId ?? message.messageId, title
    });
    await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(defaultProject), paneId: null });
    try {
      const pane = await this.herdr.createPane(binding.workspaceId, defaultProject.cwd, { bindingId: binding.id, generation: binding.generation, projectId: defaultProject.id });
      binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null });
      binding = this.store.transitionBinding(binding.id, { type: "pane_created" });
      await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
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

  private async createFromHerdr(pane: Awaited<ReturnType<HerdrPort["listPanes"]>>[number], project: ProjectConfig): Promise<void> {
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
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<void> {
    if (this.store.countPendingPrompts(binding.id) >= this.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID();
    const occurredAt = new Date().toISOString();
    const activeRun = this.activeRuns.get(binding.id);
    const parentPromptId = activeRun?.state === "working" ? activeRun.promptId : null;
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
      if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.scheduleSteering(binding.id, prompt.parentPromptId);
      else this.scheduleWorker(binding.id);
      return;
    }
    const depth = this.store.countPendingPrompts(binding.id);
    this.logger.info({ event: "prompt-dispatch-decided", eventId: message.eventId, messageId: message.messageId, bindingId: binding.id, promptId: prompt.id, parentPromptId, workspaceId: binding.workspaceId, paneId: binding.paneId, dispatchKind, queueDepth: depth, outcome: inserted ? "accepted" : "duplicate" }, "accepted Lark prompt dispatch decision");
    if (dispatchKind === "steering" && parentPromptId) {
      await this.publish(binding.id, "SteeringQueued", "lark", { promptId: prompt.id, parentPromptId, actorOpenId: message.actorOpenId });
    } else {
      await this.publish(binding.id, "PromptQueued", "lark", { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    }
    if (dispatchKind === "turn") await this.refreshQueuePositions(binding.id);
    this.store.audit({ actorOpenId: message.actorOpenId, action: dispatchKind === "steering" ? "prompt.steer" : "prompt.queue", target: binding.id, outcome: "success" });
    await this.channelPublisher.drain();
    if (dispatchKind === "steering" && parentPromptId) this.scheduleSteering(binding.id, parentPromptId);
    else this.scheduleWorker(binding.id);
  }

  private scheduleSteering(bindingId: string, parentPromptId: string): void {
    const previous = this.steeringWorkers.get(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainSteering(bindingId, parentPromptId)).finally(() => {
      if (this.steeringWorkers.get(bindingId) === worker) this.steeringWorkers.delete(bindingId);
    });
    this.steeringWorkers.set(bindingId, worker);
  }

  private async drainSteering(bindingId: string, parentPromptId: string): Promise<void> {
    const activeRun = this.activeRuns.get(bindingId);
    if (!activeRun || activeRun.promptId !== parentPromptId) return;
    for (let prompt = this.store.claimNextReadySteering(bindingId, parentPromptId); prompt; prompt = this.store.claimNextReadySteering(bindingId, parentPromptId)) {
      try {
        const result = this.herdr.steerPrompt ? await this.herdr.steerPrompt(activeRun.paneId, prompt.body) : "not_working";
        if (result === "not_working") {
          this.store.requeueSteeringAsTurn(prompt.id);
          this.logger.warn({ event: "steering-fell-back-to-turn", bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "requeued", reason: "not_working" }, "steering target was no longer working");
          await this.refreshQueuePositions(bindingId);
          continue;
        }
        await this.publish(bindingId, "SteeringStarted", "bridge", { promptId: prompt.id, parentPromptId });
        this.store.updatePrompt(prompt.id, "delivered");
        await this.publish(bindingId, "SteeringDelivered", "herdr", { promptId: prompt.id, parentPromptId });
        this.logger.info({ event: "steering-delivered", bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "delivered" }, "steering delivered to active turn");
      } catch (error) {
        const message = `Steering 注入结果无法确认，请检查 Herdr pane 后按需重试：${errorMessage(error)}`;
        this.store.updatePrompt(prompt.id, "failed", message);
        await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: prompt.id, parentPromptId, error: message });
        this.logger.error({ event: "steering-failed", err: safeLogError(error), bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "uncertain" }, "steering delivery failed");
      }
    }
  }

  private scheduleWorker(bindingId: string): void {
    if (this.workers.has(bindingId)) return;
    const worker = this.drain(bindingId).finally(() => {
      this.workers.delete(bindingId);
    });
    this.workers.set(bindingId, worker);
  }

  private async drain(bindingId: string): Promise<void> {
    let binding = this.store.listBindings().find((item) => item.id === bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const paneId = binding.paneId;
    for (let prompt = this.stopping ? null : this.store.claimNextReadyPrompt(bindingId); prompt; prompt = this.stopping ? null : this.store.claimNextReadyPrompt(bindingId)) {
      const queueDepth = this.store.countPendingPrompts(bindingId);
      const startedAt = Date.now();
      try {
        await this.refreshQueuePositions(bindingId);
        const abortController = new AbortController();
        this.activeRuns.set(bindingId, { promptId: prompt.id, paneId, state: "working", abortController });
        await this.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth });
        this.logger.info({ event: "turn-started", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, queueDepth, outcome: "running" }, "TraeX turn started");
        const before = await this.herdr.readOutput(paneId, 240);
        let previousObservation = before;
        const state = await this.herdr.runPrompt(paneId, prompt.body, this.config.turnTimeoutMs, async ({ state: observedState, output }) => {
          const parsed = parseTerminalStreamDelta(previousObservation, output, prompt.body);
          previousObservation = output;
          if (parsed.delta) {
            await this.publish(bindingId, "TurnOutputObserved", "herdr", { promptId: prompt.id, answerSnapshot: parsed.delta, answerUpdate: "append", progressEvents: [] });
          }
          const previousState = this.observedAgentStates.get(paneId) ?? binding?.lastAgentState ?? "unknown";
          const activeRun = this.activeRuns.get(bindingId);
          if (activeRun?.promptId === prompt.id) activeRun.state = observedState;
          if (previousState !== observedState) {
            this.observedAgentStates.set(paneId, observedState);
            binding = this.store.transitionBinding(bindingId, { type: "pane_observed", runtime: observedState });
            await this.publish(bindingId, "AgentStateChanged", "herdr", {
              state: observedState, queueDepth: this.store.countPendingPrompts(bindingId), promptId: prompt.id
            });
            if (observedState === "blocked") this.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding?.workspaceId, paneId, agentState: observedState, queueDepth: this.store.countPendingPrompts(bindingId), outcome: "waiting_for_user" }, "TraeX turn requires user action");
          }
        }, abortController.signal);
        const stateBeforeReturn = binding.lastAgentState;
        const activeRun = this.activeRuns.get(bindingId);
        if (activeRun?.promptId === prompt.id) activeRun.state = state;
        this.observedAgentStates.set(paneId, state);
        binding = this.store.transitionBinding(bindingId, { type: "pane_observed", runtime: state });
        if (stateBeforeReturn !== state) {
          await this.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
        }
        const after = await this.herdr.readOutput(paneId, 240);
        const answer = extractFinalTraexAnswer(after);
        const fingerprint = outputFingerprint(answer);
        this.observedTerminalOutputs.set(paneId, cleanTerminalOutput(after));
        this.store.updateBinding(bindingId, { lastOutputFingerprint: fingerprint });
        this.store.updatePrompt(prompt.id, "delivered");
        binding = this.store.transitionBinding(bindingId, { type: "turn_completed" });
        const streamed = this.store.loadRunCard(prompt.id)?.answer ?? "";
        await this.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: streamed || answer || "TraeX 已完成，但没有可安全展示的文本输出。请查看 Herdr pane。", queueDepth: this.store.countPendingPrompts(bindingId) });
        this.logger.info({ event: "turn-completed", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "completed" }, "TraeX turn completed");
        await this.refreshQueuePositions(bindingId);
      } catch (error) {
        this.store.updatePrompt(prompt.id, "failed", errorMessage(error));
        await this.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: errorMessage(error), queueDepth: this.store.countPendingPrompts(bindingId) });
        this.logger.error({ event: "turn-failed", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed" }, "TraeX turn failed");
        await this.refreshQueuePositions(bindingId);
        if (binding.lastAgentState === "blocked") return;
      } finally {
        const steeringWorker = this.steeringWorkers.get(bindingId);
        if (steeringWorker) await steeringWorker;
        if (this.store.requeueQueuedSteering(bindingId, prompt.id) > 0) await this.refreshQueuePositions(bindingId);
        if (this.activeRuns.get(bindingId)?.promptId === prompt.id) this.activeRuns.delete(bindingId);
        const latestBinding = this.store.listBindings().find((item) => item.id === bindingId);
        if (latestBinding?.lifecycle === "draining") {
          await this.transitionAndPublish(latestBinding, { type: "drain_completed" }, "BindingArchived", "bridge", { reason: "当前任务已结束，话题归档完成；Herdr pane 与 TraeX 保持运行。" });
        }
      }
    }
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
    if (this.activeRuns.has(binding.id) || this.workers.has(binding.id) || this.store.countPendingPrompts(binding.id) > 0 || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") {
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
      const output = await this.herdr.runPaneCommand(pane.paneId, name ? `/model ${name}` : "/model", this.config.commandTimeoutMs);
      await this.replyStandalone(message.rootMessageId ?? message.messageId, renderModelResultCard({ spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: name !== null }));
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: name ? "switch_completed" : "list_completed" });
      return true;
    } catch (error) {
      await this.reject(message, `模型命令执行失败：${errorMessage(error)}`);
      this.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "failed" });
      return false;
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

    const interruptedSelections = this.store.listProcessingProjectSelections().filter((selection) => {
      if (!selection.bindingId || selection.selectedProjectId !== project.id) return false;
      const binding = this.store.listBindings().find((candidate) => candidate.id === selection.bindingId);
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
    const pane = (await this.herdr.listPanes(binding.workspaceId, { forceRefresh: true })).find((candidate) => candidate.paneId === paneId) ?? null;
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
    const pane = await this.herdr.createPane(project.workspaceId, project.cwd, { bindingId: binding.id, generation: binding.generation + 1, projectId: project.id });
    await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
    const next = this.store.attachBindingPane(binding.id, pane, true);
    await this.publish(next.id, "BindingArchived", "lark", { reason: "Replacement Pane 已创建；为避免重放不确定任务，发送 `/herdr resume` 后才继续队列。" });
    this.store.audit({ actorOpenId, action: "binding.replace", target: binding.id, outcome: "success" });
  }

  private spaceNameFor(binding: Binding): string {
    const matches = binding.projectId
      ? this.config.projects.filter((project) => project.id === binding.projectId)
      : this.config.projects.filter((project) => project.workspaceId === binding.workspaceId);
    return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved";
  }

  private async refreshQueuePositions(bindingId: string): Promise<void> {
    const queuedTurnIds = new Set(this.store.listQueuedTurnPromptIds(bindingId));
    const queued = this.store.listRunCards(bindingId).filter((view) => view.phase === "queued" && queuedTurnIds.has(view.promptId));
    for (const [index, view] of queued.entries()) {
      const position = index + 1;
      if (view.queuePosition !== position) await this.publish(bindingId, "RunQueuePositionChanged", "bridge", { promptId: view.promptId, queuePosition: position });
    }
  }

  private async replyStandalone(rootMessageId: string, card: object): Promise<void> {
    await this.channelPublisher.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card);
  }

  private event<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<BridgeEvent, { type: T }>["payload"]): Extract<BridgeEvent, { type: T }> {
    return { eventId: randomUUID(), bindingId, type, origin, occurredAt: new Date().toISOString(), payload } as Extract<BridgeEvent, { type: T }>;
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<BridgeEvent, { type: T }>["payload"]): Promise<void> {
    const event = { eventId: randomUUID(), bindingId, type, origin, occurredAt: new Date().toISOString(), payload } as BridgeEvent;
    await this.bus.publish(event);
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

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
function isPaneMissing(error: unknown): boolean { return /(?:pane|agent).*(?:not found|does not exist)|agent_not_found/i.test(errorMessage(error)); }
function parseOpenThreadAction(value: unknown): { bindingId: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== "open_project_thread" || typeof candidate.bindingId !== "string") return null;
  return { bindingId: candidate.bindingId };
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

function extractTraexAnswer(output: string): string | null {
  const marker = /^\s*◆\s+/m.exec(output);
  if (!marker || marker.index === undefined) return null;
  const answer = output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trim() ?? "";
  return answer || null;
}

export function extractNewOutput(before: string, after: string): string {
  if (!before || !after.startsWith(before)) return after;
  return after.slice(before.length).trimStart();
}
