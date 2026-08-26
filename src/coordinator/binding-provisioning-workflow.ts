import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderAttachStatusCard, renderMessageRejectedCard, renderProjectEntryCard, renderProjectSelectionStatusCard, renderProjectSelectorCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { BindingProvisioningStore, HerdrPort, LarkPort, OutboundIntentPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig, ProjectSelection } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";

export interface BindingProvisioningWorkflowPort {
  createRoot(message: IncomingLarkMessage, title: string): Promise<Binding>;
  selectProject(message: IncomingLarkMessage, requestedTitle: string | null): Promise<void>;
  completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<void>;
  attach(message: IncomingLarkMessage, spaceName: string, paneReference: string): Promise<boolean>;
  reset(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean>;
  reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void>;
  replace(binding: Binding, actorOpenId: string): Promise<void>;
  discover(pane: HerdrPane, project: ProjectConfig): Promise<Binding>;
  recover(): Promise<void>;
}

interface Options {
  config: BridgeConfig;
  store: BindingProvisioningStore;
  herdr: HerdrPort;
  lark: LarkPort;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  wakeRetiredPaneCleanup?: () => void;
  logger: Logger;
}

export class BindingProvisioningWorkflow implements BindingProvisioningWorkflowPort {
  private readonly projectsById: Map<string, ProjectConfig>;
  private readonly projectsBySpaceName: Map<string, ProjectConfig[]>;

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    this.projectsBySpaceName = new Map();
    for (const project of options.config.projects) {
      const spaceName = project.spaceName;
      if (!spaceName) continue;
      const projects = this.projectsBySpaceName.get(spaceName) ?? [];
      projects.push(project);
      this.projectsBySpaceName.set(spaceName, projects);
    }
  }

  async createRoot(message: IncomingLarkMessage, requestedTitle: string): Promise<Binding> {
    const { config, store, herdr } = this.options;
    const project = this.projectsById.get(config.defaultProjectId) ?? config.projects[0]!;
    const paneTitle = requestedTitle || randomPaneName();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    let binding = store.createPendingBinding({
      id: randomUUID(), projectId: project.id, workspaceId: project.workspaceId, chatId: message.chatId,
      topicId: message.topicId ?? message.messageId, rootMessageId: message.rootMessageId ?? message.messageId, title
    });
    await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: null });
    try {
      const pane = await herdr.createPane(binding.workspaceId, project.cwd, { bindingId: binding.id, generation: binding.generation, projectId: project.id, placement: "dedicated-tab", title: paneTitle });
      binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(pane));
      binding = store.transitionBinding(binding.id, { type: "pane_created" });
      await herdr.startTraex(pane.paneId, config.traex.executable);
      const startedPane = await this.requireStartedPane(project, pane.paneId, binding.traexSessionId);
      binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(startedPane));
      binding = store.transitionBinding(binding.id, { type: "runtime_started", runtime: startedPane.agentState });
      binding = store.transitionBinding(binding.id, { type: "thread_created" });
      binding = store.transitionBinding(binding.id, { type: "activate" });
      await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: binding.topicId! });
      store.audit({ actorOpenId: message.actorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
      return binding;
    } catch (error) {
      store.transitionBinding(binding.id, { type: "provisioning_failed" });
      await this.publish(binding.id, "TurnFailed", "bridge", { promptId: message.messageId, error: errorMessage(error), queueDepth: 0 });
      throw error;
    }
  }

  async selectProject(message: IncomingLarkMessage, requestedTitle: string | null): Promise<void> {
    const selectionId = randomUUID();
    this.options.store.createProjectSelection({
      id: selectionId, commandMessageId: message.messageId, chatId: message.chatId, topicId: message.topicId,
      rootMessageId: message.rootMessageId ?? message.messageId, actorOpenId: message.actorOpenId, requestedTitle,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), card: renderProjectSelectorCard({ selectionId, projects: this.options.config.projects })
    });
    this.options.outboundWork.wake();
  }

  async completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<void> {
    const { store, config, outbound, logger } = this.options;
    const claim = store.claimProjectSelection({
      selectionId, projectId, messageId: action.messageId, chatId: action.chatId, actorOpenId: action.operatorOpenId,
      allowedProjectIds: config.projects.map((project) => project.id)
    });
    logger.info({ event: "project-selection-decided", selectionId, projectId, messageId: action.messageId, outcome: claim.outcome }, "processed project selection action");
    store.audit({ actorOpenId: action.operatorOpenId, action: "project.select", target: `${selectionId}:${projectId}`, outcome: claim.outcome });
    if (!claim.selection || claim.outcome === "missing" || claim.outcome === "invalid" || claim.outcome === "unauthorized" || claim.outcome === "processing") return;
    if (claim.outcome === "expired") {
      await outbound.enqueueCardUpdate(null, action.messageId, `selection:${selectionId}:expired`, renderProjectSelectionStatusCard({ status: "expired", message: "请重新发送 /swarm new。" }));
      return;
    }
    const selection = claim.selection;
    if (claim.outcome === "completed") {
      const binding = selection.bindingId ? store.getBinding(selection.bindingId) : null;
      const project = selection.selectedProjectId ? this.projectsById.get(selection.selectedProjectId) : undefined;
      if (binding && project) await this.publishSelectionSuccess(selection.id, action.messageId, project, binding);
      return;
    }
    const project = this.projectsById.get(projectId);
    if (!project) return;
    await outbound.enqueueCardUpdate(null, action.messageId, `selection:${selectionId}:processing`, renderProjectSelectionStatusCard({ status: "processing", projectName: project.displayName, spaceName: projectSpaceName(project) }));
    try {
      const binding = await this.createSelectedProject(selection, project, true);
      store.completeProjectSelection(selection.id, binding.id);
      await this.publishSelectionSuccess(selection.id, action.messageId, project, binding);
      store.audit({ actorOpenId: action.operatorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
    } catch (error) {
      store.pauseProjectSelection(selection.id, errorMessage(error));
      await outbound.enqueueCardUpdate(null, action.messageId, `selection:${selectionId}:recoverable`, renderProjectSelectionStatusCard({
        status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project), message: provisioningRecoveryMessage(error)
      }));
      logger.error({ event: "project-selection-paused", err: safeLogError(error), selectionId, projectId, outcome: "retry_on_restart" }, "project selection paused at a recoverable checkpoint");
    }
  }

  async recover(): Promise<void> {
    const selections = this.options.store.listProcessingProjectSelections();
    for (const selection of selections) await this.recoverProjectSelection(selection);
    const selectionBindingIds = new Set(selections.flatMap((selection) => selection.bindingId ? [selection.bindingId] : []));
    for (const binding of this.options.store.listBindingsByState("pending").filter((candidate) =>
      candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "runtime_started" && !selectionBindingIds.has(candidate.id)
    )) await this.recoverDiscoveredBinding(binding);
  }

  async discover(pane: HerdrPane, project: ProjectConfig): Promise<Binding> {
    const { store, lark, lifecycleEvents, config } = this.options;
    const id = randomUUID();
    const title = formatProjectPaneTitle(projectSpaceName(project), pane.cwd, pane.label, pane.paneId);
    let binding = store.createPendingBinding({ id, projectId: project.id, workspaceId: pane.workspaceId, chatId: config.lark.chatId, topicId: null, rootMessageId: null, title });
    binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(pane));
    binding = store.transitionBinding(binding.id, { type: "pane_created" });
    binding = store.transitionBinding(binding.id, { type: "runtime_started" });
    const createdEvent = createBridgeEvent(binding.id, "BindingCreated", "herdr", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId });
    const initialView = reduceTopicView(initialTopicView(binding.id), createdEvent);
    store.saveTopicView(initialView);
    const topic = await lark.createTopic(renderProjectEntryCard(initialView), binding.id);
    store.recordBridgeMessage(topic.rootMessageId);
    store.saveTopicView({ ...initialView, deliveredVersion: initialView.viewVersion });
    binding = store.updateBindingMetadata(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId });
    binding = store.transitionBinding(binding.id, { type: "thread_created" });
    binding = store.transitionBinding(binding.id, { type: "activate" });
    await lifecycleEvents.publish(createdEvent);
    await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: topic.topicId });
    return binding;
  }

  async reset(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean> {
    const { store, config, herdr, scheduler, logger } = this.options;
    if (!binding || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached" || !binding.projectId || !binding.topicId || !binding.rootMessageId) {
      await this.reject(message, "`/swarm reset` 只能在已连接且活动中的项目话题内使用。"); return false;
    }
    const project = this.projectsById.get(binding.projectId);
    if (!project) { await this.reject(message, "当前会话的项目配置已不存在，不能开启新会话。"); return false; }
    const paneTitle = requestedTitle ?? randomPaneName();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    const candidate = store.createResetCandidate({ oldBindingId: binding.id, newBindingId: randomUUID(), title, actorOpenId: message.actorOpenId, resetMessageId: message.messageId });
    try {
      let replacement = candidate.replacement;
      if (!candidate.created && replacement.provisioningCheckpoint === "selected") throw new Error("Reset candidate may already have created a pane; inspect the Space and attach the surviving pane instead of retrying creation");
      let pane = replacement.paneId ? await herdr.getPane(replacement.paneId) : null;
      if (replacement.provisioningCheckpoint === "selected") {
        pane = await herdr.createPane(project.workspaceId, project.cwd, { bindingId: replacement.id, generation: replacement.generation, projectId: project.id, placement: "dedicated-tab", title: paneTitle });
        replacement = store.updateBindingMetadata(replacement.id, paneIdentityPatch(pane));
        replacement = store.transitionBinding(replacement.id, { type: "pane_created" });
      }
      if (!pane) throw new Error(`Provisioned Herdr pane ${replacement.paneId ?? "unknown"} no longer exists`);
      if (replacement.provisioningCheckpoint === "pane_created") {
        await herdr.startTraex(pane.paneId, config.traex.executable);
        const startedPane = await this.requireStartedPane(project, pane.paneId, replacement.traexSessionId);
        replacement = store.updateBindingMetadata(replacement.id, paneIdentityPatch(startedPane));
        replacement = store.transitionBinding(replacement.id, { type: "runtime_started", runtime: startedPane.agentState });
        pane = startedPane;
      }
      const observedPane = await this.requireStartedPane(project, pane.paneId, replacement.traexSessionId);
      replacement = store.updateBindingMetadata(replacement.id, paneIdentityPatch(observedPane));
      replacement = store.transitionBinding(replacement.id, { type: "pane_observed", runtime: observedPane.agentState });
      pane = observedPane;
      const handoff = store.cutoverResetCandidate({ oldBindingId: binding.id, newBindingId: replacement.id, cleanupOperationId: randomUUID(), actorOpenId: message.actorOpenId, expectedCwd: project.cwd });
      replacement = handoff.replacement;
      this.options.wakeRetiredPaneCleanup?.();
      scheduler.wake({ kind: "binding-runtime-changed", bindingId: binding.id });
      await this.publish(replacement.id, "BindingCreated", "lark", { title, workspaceId: replacement.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId });
      await this.publish(replacement.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: replacement.topicId! });
      await this.reply(replacement.rootMessageId!, renderMessageRejectedCard(`已开启新会话：${pane.paneId}。旧 Herdr pane ${handoff.previous.paneId ?? "(unknown)"} 将在确认空闲后安全关闭。`));
      logger.info({ event: "binding-reset-completed", previousBindingId: handoff.previous.id, bindingId: replacement.id, paneId: pane.paneId, outcome: "active" }, "reset Lark topic to a new Herdr session");
      return true;
    } catch (error) {
      const failedCandidate = store.getBinding(candidate.replacement.id);
      if (failedCandidate?.lifecycle === "provisioning") store.transitionBinding(failedCandidate.id, { type: "provisioning_failed" });
      await this.reject(message, `新会话创建失败，旧会话仍连接本话题：${errorMessage(error)}。如果新 Pane 已出现，请先检查 Herdr，避免重复创建。`);
      logger.error({ event: "binding-reset-failed", err: safeLogError(error), previousBindingId: candidate.previous.id, bindingId: candidate.replacement.id, outcome: "failed" }, "new session provisioning failed before topic cutover");
      return false;
    }
  }

  async attach(message: IncomingLarkMessage, spaceName: string, paneReference: string): Promise<boolean> {
    const { config, store, herdr } = this.options;
    const projects = this.projectsBySpaceName.get(spaceName) ?? [];
    if (projects.length !== 1) {
      await this.reject(message, projects.length === 0 ? `未找到空间 ${spaceName}。` : `空间 ${spaceName} 对应多个项目，无法确定要连接哪一个。`);
      store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: projects.length === 0 ? "unknown_space" : "ambiguous_space" }); return false;
    }
    const project = projects[0]!;
    const panes = (await herdr.listPanes(project.workspaceId, { forceRefresh: true })).filter((candidate) => candidate.workspaceId === project.workspaceId);
    const exactId = panes.find((candidate) => candidate.paneId === paneReference);
    const labelMatches = exactId ? [] : panes.filter((candidate) => candidate.label === paneReference);
    if (!exactId && labelMatches.length > 1) {
      await this.reject(message, `Pane 名称 ${paneReference} 不唯一，请改用 Pane ID：${labelMatches.map((candidate) => candidate.paneId).sort().join(", ")}`);
      store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_label" }); return false;
    }
    const pane = exactId ?? labelMatches[0];
    if (!pane) { await this.reject(message, `在空间 ${spaceName} 的 Herdr workspace ${project.workspaceId} 中未找到 Pane ${paneReference}。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "pane_not_found" }); return false; }
    const existing = store.findBindingByPane(pane.paneId);
    if (existing) {
      if (this.isRecoverableFailedReset(existing, message, project)) { const recovered = await this.recoverFailedResetBinding(existing, pane, message.actorOpenId); await this.publishAttachSuccess(message, recovered, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.attachment === "orphaned" && existing.topicId && existing.rootMessageId) {
        const observedPane = await this.requireMatchingPane(existing, pane.paneId);
        const recovered = store.attachBindingPane(existing.id, observedPane, false);
        await this.publish(recovered.id, "BindingArchived", "lark", { reason: "Pane 已验证并恢复连接；为避免重放不确定任务，请进入原话题发送 `/swarm resume` 后再继续队列。" });
        await this.publishAttachSuccess(message, recovered, spaceName, true, true);
        store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_orphaned" });
        return true;
      }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.state === "active") { await this.publishAttachSuccess(message, existing, spaceName, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "already_attached" }); return true; }
      await this.reject(message, `Pane ${pane.paneId} 已绑定到其他会话，不能在这里重新连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "bound_elsewhere" }); return false;
    }
    if (!pane.foregroundExecutables.includes("traex")) { await this.reject(message, `Pane ${pane.paneId} 当前没有运行 TraeX，未执行连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: pane.paneId, outcome: "traex_not_running" }); return false; }
    const topicBinding = store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (topicBinding && this.isRecoverableFailedReset(topicBinding, message, project)) { const recovered = await this.recoverFailedResetBinding(topicBinding, pane, message.actorOpenId); await this.publishAttachSuccess(message, recovered, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
    const interrupted = store.listProcessingProjectSelections().filter((selection) => selection.bindingId && selection.selectedProjectId === project.id && store.getBinding(selection.bindingId)?.provisioningCheckpoint === "selected");
    if (interrupted.length === 1) {
      const selection = interrupted[0]!;
      let binding = store.updateBindingMetadata(selection.bindingId!, paneIdentityPatch(pane));
      binding = store.transitionBinding(binding.id, { type: "pane_created" });
      binding = await this.createSelectedProject(selection, project, false);
      store.completeProjectSelection(selection.id, binding.id);
      if (selection.selectorMessageId) await this.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding);
      await this.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "recovered_provisioning" }); return true;
    }
    const binding = await this.discover(pane, project);
    await this.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "success" }); return true;
  }

  async reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void> {
    const pane = await this.requireMatchingPane(binding, paneId);
    const next = this.options.store.attachBindingPane(binding.id, pane, false);
    await this.publish(next.id, "BindingArchived", "lark", { reason: "Pane 已验证并连接；为避免重放不确定任务，发送 `/swarm resume` 后才继续队列。" });
    this.options.store.audit({ actorOpenId, action: "binding.reattach", target: binding.id, outcome: "success" });
  }

  async replace(binding: Binding, actorOpenId: string): Promise<void> {
    const { config, herdr, store } = this.options;
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined;
    if (!project) throw new Error(`Project configuration missing for binding ${binding.id}`);
    const existingPane = binding.paneId ? await herdr.getPane(binding.paneId) : null;
    const paneTitle = existingPane?.label?.trim() || binding.title.split(" / ").at(-1) || project.displayName;
    const pane = await herdr.createPane(project.workspaceId, project.cwd, { bindingId: binding.id, generation: binding.generation + 1, projectId: project.id, placement: "dedicated-tab", title: paneTitle });
    await herdr.startTraex(pane.paneId, config.traex.executable);
    const startedPane = await this.requireStartedPane(project, pane.paneId, pane.terminalId ?? null);
    const next = store.transitionBinding(store.attachBindingPane(binding.id, startedPane, true).id, { type: "pane_observed", runtime: startedPane.agentState });
    await this.publish(next.id, "BindingArchived", "lark", { reason: "Replacement Pane 已创建；为避免重放不确定任务，发送 `/swarm resume` 后才继续队列。" });
    store.audit({ actorOpenId, action: "binding.replace", target: binding.id, outcome: "success" });
  }

  private async createSelectedProject(selection: ProjectSelection, project: ProjectConfig, allowPaneCreation: boolean): Promise<Binding> {
    const { store, herdr, lark, config, logger } = this.options;
    const bindingId = selection.bindingId ?? randomUUID();
    const paneTitle = selection.requestedTitle ?? randomPaneName();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    let binding = selection.bindingId ? store.getBinding(selection.bindingId) : null;
    if (!binding) { binding = store.createPendingBinding({ id: bindingId, projectId: project.id, workspaceId: project.workspaceId, chatId: selection.chatId, topicId: null, rootMessageId: null, title }); store.linkProjectSelectionBinding(selection.id, binding.id); await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: null }); }
    try {
      let pane = binding.paneId ? await herdr.getPane(binding.paneId) : null;
      if (binding.paneId && !pane) throw new Error(`Provisioned Herdr pane ${binding.paneId} no longer exists`);
      if (pane && binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${binding.paneId}`);
      if (binding.provisioningCheckpoint === "selected") {
        if (!allowPaneCreation) throw new Error("Interrupted while creating the Herdr pane; inspect the Space and attach the surviving pane with /swarm attach <space> <pane>");
        pane = await herdr.createPane(project.workspaceId, project.cwd, { bindingId: binding.id, generation: binding.generation, projectId: project.id, placement: "dedicated-tab", title: paneTitle });
        binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(pane)); binding = store.transitionBinding(binding.id, { type: "pane_created" });
      }
      if (!pane && binding.paneId) pane = await herdr.getPane(binding.paneId);
      if (!pane) throw new Error(`Provisioning checkpoint ${binding.provisioningCheckpoint} has no Herdr pane`);
      if (binding.provisioningCheckpoint === "pane_created") {
        await herdr.startTraex(pane.paneId, config.traex.executable);
        pane = await this.requireStartedPane(project, pane.paneId, binding.traexSessionId);
        binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(pane));
        binding = store.transitionBinding(binding.id, { type: "runtime_started", runtime: pane.agentState });
      }
      const activatedEvent = createBridgeEvent(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: "pending" });
      const activeView = reduceTopicView(store.loadTopicView(binding.id) ?? initialTopicView(binding.id), activatedEvent);
      if (binding.provisioningCheckpoint === "runtime_started") { const topic = await lark.createTopic(renderProjectEntryCard(activeView), binding.id); store.recordBridgeMessage(topic.rootMessageId); store.saveTopicView({ ...activeView, deliveredVersion: activeView.viewVersion }); binding = store.updateBindingMetadata(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId }); binding = store.transitionBinding(binding.id, { type: "thread_created" }); }
      if (binding.provisioningCheckpoint === "thread_created") binding = store.transitionBinding(binding.id, { type: "activate" });
      await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: binding.topicId! }); return binding;
    } catch (error) { logger.warn({ event: "project-provisioning-paused", err: safeLogError(error), selectionId: selection.id, bindingId: binding.id, checkpoint: binding.provisioningCheckpoint, outcome: "retry_on_restart" }, "project provisioning paused at a durable checkpoint"); throw error; }
  }

  private async recoverProjectSelection(selection: ProjectSelection): Promise<void> {
    const { store, config, outbound, logger } = this.options;
    const project = selection.selectedProjectId ? this.projectsById.get(selection.selectedProjectId) ?? null : null;
    if (!selection.bindingId || !project) { store.failProjectSelection(selection.id, "Interrupted before recoverable project identity was persisted"); return; }
    try { const binding = await this.createSelectedProject(selection, project, false); store.completeProjectSelection(selection.id, binding.id); if (selection.selectorMessageId) await this.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding); logger.info({ event: "project-selection-recovered", selectionId: selection.id, bindingId: binding.id, paneId: binding.paneId, outcome: "completed" }, "resumed interrupted project provisioning"); }
    catch (error) { store.pauseProjectSelection(selection.id, errorMessage(error)); if (selection.selectorMessageId) await outbound.enqueueCardUpdate(null, selection.selectorMessageId, `selection:${selection.id}:recoverable`, renderProjectSelectionStatusCard({ status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project), message: errorMessage(error) })); logger.error({ event: "project-selection-recovery-failed", err: safeLogError(error), selectionId: selection.id, bindingId: selection.bindingId, outcome: "retry_on_restart" }, "project provisioning remains recoverable"); }
  }

  private async recoverDiscoveredBinding(binding: Binding): Promise<void> {
    if (!binding.paneId || !binding.projectId) return;
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined; if (!project) return;
    try { const pane = await this.requireMatchingPane(binding, binding.paneId); const createdEvent = createBridgeEvent(binding.id, "BindingCreated", "herdr", { title: binding.title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId }); const view = reduceTopicView(this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id), createdEvent); const topic = await this.options.lark.createTopic(renderProjectEntryCard(view), binding.id); this.options.store.recordBridgeMessage(topic.rootMessageId); this.options.store.saveTopicView({ ...view, deliveredVersion: view.viewVersion }); let next = this.options.store.updateBindingMetadata(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId }); next = this.options.store.transitionBinding(next.id, { type: "thread_created" }); next = this.options.store.transitionBinding(next.id, { type: "activate" }); await this.options.lifecycleEvents.publish(createdEvent); await this.publish(next.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: topic.topicId }); this.options.logger.info({ event: "discovered-binding-recovered", bindingId: next.id, paneId: pane.paneId, outcome: "completed" }, "resumed interrupted discovered-pane provisioning"); }
    catch (error) { this.options.logger.error({ event: "discovered-binding-recovery-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, outcome: "retry_on_restart" }, "discovered-pane provisioning remains recoverable"); }
  }

  private async requireMatchingPane(binding: Binding, paneId: string): Promise<HerdrPane> {
    let pane = (await this.options.herdr.observeRuntime(paneId)).pane;
    if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
    if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`);
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined;
    if (project && pane.cwd !== project.cwd) throw new Error(`Herdr pane ${paneId} does not match project ${project.displayName}`);
    if (hasNativeAgentSession(binding)) {
      if (pane.agentSession && !sameNativeAgentSession(binding, pane)) throw new Error(`Herdr Agent session identity changed for ${paneId}`);
    }
    if (binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId && !sameNativeAgentSession(binding, pane)) throw new Error(`Herdr pane identity changed for ${paneId}`);
    if (hasNativeAgentSession(binding) && !pane.agentSession) pane = { ...pane, agentSession: persistedAgentSession(binding) };
    if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${paneId}`);
    return pane;
  }

  private async requireStartedPane(project: ProjectConfig, paneId: string, expectedTerminalId: string | null): Promise<HerdrPane> {
    const observation = await this.options.herdr.observeRuntime(paneId);
    const pane = observation.pane;
    if (!pane || !observation.traexProcess || !observation.composerReady || pane.workspaceId !== project.workspaceId || pane.cwd !== project.cwd || !pane.terminalId) {
      throw new Error(`TraeX runtime in pane ${paneId} is not ready`);
    }
    if (expectedTerminalId && pane.terminalId !== expectedTerminalId) throw new Error(`Herdr pane identity changed for ${paneId}`);
    return pane;
  }

  private isRecoverableFailedReset(binding: Binding, message: IncomingLarkMessage, project: ProjectConfig): boolean {
    return binding.state === "failed" && binding.projectId === project.id && binding.chatId === message.chatId && (
      (binding.topicId === message.topicId && binding.rootMessageId === message.rootMessageId) ||
      (binding.reservedTopicId === message.topicId && binding.reservedRootMessageId === message.rootMessageId && Boolean(binding.replacesBindingId))
    );
  }
  private async recoverFailedResetBinding(binding: Binding, pane: HerdrPane, actorOpenId: string): Promise<Binding> {
    if (!binding.replacesBindingId || !binding.reservedTopicId || !binding.reservedRootMessageId) {
      if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${pane.paneId}`);
      const identified = this.options.store.updateBindingMetadata(binding.id, { ...paneIdentityPatch(pane), statusMessageId: binding.rootMessageId });
      const recovered = this.options.store.transitionBinding(identified.id, { type: "recover_failed", runtime: pane.agentState });
      await this.publish(recovered.id, "BindingActivated", "lark", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: recovered.topicId! });
      return recovered;
    }
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined;
    const observation = await this.options.herdr.observeRuntime(pane.paneId);
    if (!project || !observation.pane || !observation.traexProcess || !observation.composerReady || observation.pane.workspaceId !== project.workspaceId || observation.pane.cwd !== project.cwd || !observation.pane.terminalId) throw new Error(`Replacement pane ${pane.paneId} is not ready for reset recovery`);
    const identified = this.options.store.updateBindingMetadata(binding.id, paneIdentityPatch(observation.pane));
    this.options.store.transitionBinding(identified.id, { type: "retry_failed_provisioning", runtime: observation.pane.agentState });
    const handoff = this.options.store.cutoverResetCandidate({ oldBindingId: binding.replacesBindingId, newBindingId: binding.id, cleanupOperationId: randomUUID(), actorOpenId, expectedCwd: project.cwd });
    this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: handoff.previous.id });
    this.options.wakeRetiredPaneCleanup?.();
    await this.publish(handoff.replacement.id, "BindingActivated", "lark", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: handoff.replacement.topicId! });
    return handoff.replacement;
  }
  private async publishSelectionSuccess(selectionId: string, selectorMessageId: string, project: ProjectConfig, binding: Binding): Promise<void> { await this.options.outbound.enqueueCardUpdate(null, selectorMessageId, `selection:${selectionId}:completed`, renderProjectSelectionStatusCard({ status: "completed", projectName: project.displayName, spaceName: projectSpaceName(project), ...(binding.rootMessageId ? { bindingId: binding.id } : {}), ...(binding.paneId ? { paneId: binding.paneId } : {}) })); }
  private async publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean, resumeRequired = false): Promise<void> { if (!binding.paneId) return; await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `attach:${message.messageId}:${alreadyAttached ? "existing" : "created"}`, renderAttachStatusCard({ spaceName, paneId: binding.paneId, ...(binding.rootMessageId ? { bindingId: binding.id } : {}), alreadyAttached, resumeRequired })); }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
  private async publish(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload) as ReturnType<typeof createBridgeEvent>); }
}

function paneIdentityPatch(pane: HerdrPane): Pick<Binding, "paneId" | "traexSessionId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"> {
  return {
    paneId: pane.paneId, traexSessionId: pane.terminalId ?? null,
    agentSessionSource: pane.agentSession?.source ?? null, agentSessionAgent: pane.agentSession?.agent ?? null,
    agentSessionKind: pane.agentSession?.kind ?? null, agentSessionValue: pane.agentSession?.value ?? null
  };
}
function hasNativeAgentSession(binding: Binding): boolean { return Boolean(binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue); }
function sameNativeAgentSession(binding: Binding, pane: HerdrPane): boolean {
  return Boolean(pane.agentSession && binding.agentSessionSource === pane.agentSession.source && binding.agentSessionAgent === pane.agentSession.agent && binding.agentSessionKind === pane.agentSession.kind && binding.agentSessionValue === pane.agentSession.value);
}
function persistedAgentSession(binding: Binding): NonNullable<HerdrPane["agentSession"]> {
  return { source: binding.agentSessionSource!, agent: binding.agentSessionAgent!, kind: binding.agentSessionKind!, value: binding.agentSessionValue! };
}

function randomPaneName(): string { const suffix = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4); return `task-${suffix}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function provisioningRecoveryMessage(error: unknown): string { const detail = errorMessage(error); return detail.includes("/swarm attach") ? `创建结果无法自动确认。请先检查对应 Space：若 Pane 已存在，发送 \`/swarm attach <space> <pane>\`；若不存在，再发送 \`/swarm new\`。${detail}` : `创建已停在可恢复检查点，bridge 会安全重试。${detail}`; }
