import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { GatewayEffectPort } from "../gateways/effect-client.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { BindingProvisioningStore, RuntimeIdentityTransitionApplication, RuntimeIdentityTransitionFence } from "../domain/ports/binding.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { createPrimaryPaneToken } from "../domain/pane-title.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig, ProjectSelection } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";
import { decidePaneCreatedCheckpoint, decideSelectedCheckpoint } from "./binding-provisioning-policy.js";
import { ManagedBindingLifecycle, PRIMARY_TOOLS_UNAVAILABLE_NOTICE, paneCreationOptions, primaryToolAgentArgs, type PrimaryToolConfiguration } from "./binding-provisioning/managed-binding-lifecycle.js";
import { ProjectSelectionUseCase, ProvisionedPaneMissingError } from "./binding-provisioning/project-selection-use-case.js";
import { BindingAttachmentUseCase } from "./binding-provisioning/binding-attachment-use-case.js";
import { BindingStartupRecovery } from "./binding-provisioning/binding-startup-recovery.js";
import { KeyedSerialWorkQueue } from "../runtime/keyed-serial-work-queue.js";
import { ProjectCatalog } from "./project-catalog.js";
import { agentKindFromHerdr, matchesAgentKind, type AgentKind } from "../domain/agent-instance.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import { contentIdempotencyKey } from "../domain/content-idempotency-key.js";
import { primaryManagedAgentName } from "../domain/managed-agent-name.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";

export interface BindingProvisioningWorkflowPort {
  selectProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText?: string | null, agentKind?: AgentKind): Promise<void>;
  provisionDefaultProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText?: string | null, agentKind?: AgentKind): Promise<{ binding: Binding; selection: ProjectSelection } | null>;
  ensureOrchestrator(message: IncomingLarkMessage): Promise<{ outcome: "initialized"; binding: Binding; selection: ProjectSelection } | { outcome: "existing" | "initializing"; binding: Binding } | null>;
  shareOrchestratorThread(message: IncomingLarkMessage, binding: Binding): Promise<void>;
  completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null>;
  attach(message: IncomingLarkMessage, spaceName: string | null, paneReference: string): Promise<boolean>;
  reset(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean>;
  reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void>;
  replace(binding: Binding, actorOpenId: string): Promise<void>;
  discover(pane: HerdrPane, project: ProjectConfig, activate?: boolean): Promise<Binding>;
  recover(): Promise<void>;
}

interface Options {
  config: BridgeConfig;
  store: BindingProvisioningStore;
  herdr: HerdrPort;
  gatewayEffects: GatewayEffectPort;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  primaryTools: {
    issueBinding(bindingId: string, expectedGeneration: number): PrimaryToolConfiguration;
    configurationForBinding(bindingId: string, generation: number): PrimaryToolConfiguration;
  };
  agentDrivers?: AgentDriverCatalog;
  wakeRetiredPaneCleanup?: () => void;
  logger: Logger;
  presentation: Pick<ApplicationPresentation, "projectSelector" | "projectSelectionStatus" | "attachStatus" | "mainCard" | "requestRejected">;
}

export class BindingProvisioningWorkflow implements BindingProvisioningWorkflowPort {
  private readonly orchestratorInitialization = new KeyedSerialWorkQueue<string>();
  private readonly projects: ProjectCatalog;
  private readonly managedLifecycle: ManagedBindingLifecycle;
  private readonly projectSelection: ProjectSelectionUseCase;
  private readonly attachment: BindingAttachmentUseCase;
  private readonly startupRecovery: BindingStartupRecovery;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
    this.managedLifecycle = new ManagedBindingLifecycle({
      config: options.config, store: options.store, herdr: options.herdr, projects: this.projects, primaryTools: options.primaryTools,
      requireStartedPane: (project, paneId, terminalId, agentKind) => this.requireStartedPane(project, paneId, terminalId, agentKind),
      startPrimaryAgent: (binding, pane, tools) => this.startPrimaryAgent(binding, pane, tools),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3])
    });
    this.projectSelection = new ProjectSelectionUseCase({ projects: options.config.projects, store: options.store, outbound: options.outbound, outboundWork: options.outboundWork, logger: options.logger, presentation: options.presentation, provision: async (selection, project, allowPaneCreation) => {
      const binding = selection.bindingId ? options.store.getBinding(selection.bindingId) : null;
      const runtimeProject = binding?.kind === "orchestrator" && project.orchestrator?.enabled ? await this.resolveOrchestratorProject(project) : project;
      return this.createSelectedProject(selection, runtimeProject, allowPaneCreation, binding?.kind === "orchestrator" ? "orchestrator" : undefined);
    } });
    this.attachment = new BindingAttachmentUseCase({
      config: options.config, store: options.store, herdr: options.herdr, projects: this.projects, scheduler: options.scheduler,
      ...(options.wakeRetiredPaneCleanup ? { wakeRetiredPaneCleanup: options.wakeRetiredPaneCleanup } : {}),
      createSelectedProject: (selection, project, allowPaneCreation) => this.createSelectedProject(selection, project, allowPaneCreation),
      discover: (pane, project, activate) => this.discover(pane, project, activate),
      publishSelectionSuccess: (selectionId, messageId, project, binding) => this.projectSelection.success(selectionId, messageId, project, binding),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3]),
      publishAttachSuccess: (message, binding, spaceName, alreadyAttached, resumeRequired, toolsUnavailable) => this.publishAttachSuccess(message, binding, spaceName, alreadyAttached, resumeRequired, toolsUnavailable),
      reject: (message, reason) => this.reject(message, reason)
    });
    this.startupRecovery = new BindingStartupRecovery({ store: options.store, herdr: options.herdr, gatewayEffects: options.gatewayEffects, logger: options.logger, projects: this.projects, lifecycleEvents: options.lifecycleEvents, presentation: options.presentation, recoverSelection: (selection) => this.projectSelection.recover(selection), publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3]) });
  }

  async selectProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText: string | null = null, agentKind: AgentKind = "traex"): Promise<void> {
    return this.projectSelection.begin(message, requestedTitle, initialPromptText, agentKind);
  }

  async provisionDefaultProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText: string | null = null, agentKind: AgentKind = "traex"): Promise<{ binding: Binding; selection: ProjectSelection } | null> {
    return this.projectSelection.beginDefault(message, requestedTitle, initialPromptText, agentKind, this.options.config.defaultProjectId);
  }

  async ensureOrchestrator(message: IncomingLarkMessage): Promise<{ outcome: "initialized"; binding: Binding; selection: ProjectSelection } | { outcome: "existing" | "initializing"; binding: Binding } | null> {
    return this.orchestratorInitialization.enqueue(`${this.options.config.gateway.id}:${message.chatId}`, () => this.ensureOrchestratorOnce(message));
  }

  private async ensureOrchestratorOnce(message: IncomingLarkMessage): Promise<{ outcome: "initialized"; binding: Binding; selection: ProjectSelection } | { outcome: "existing" | "initializing"; binding: Binding } | null> {
    const { config, store, logger } = this.options;
    const project = this.projects.projectById(config.defaultProjectId);
    if (!project?.orchestrator?.enabled) return null;
    let runtimeProject: ProjectConfig;
    try { runtimeProject = await this.resolveOrchestratorProject(project); }
    catch (error) {
      logger.error({ event: "orchestrator-space-resolution-failed", err: safeLogError(error), projectId: project.id, outcome: "rejected" }, "Orchestrator provisioning rejected before reserving a Binding");
      return null;
    }
    let selection = store.createAutomaticProjectSelection({
      id: randomUUID(), commandMessageId: message.messageId, chatId: message.chatId, topicId: message.topicId,
      rootMessageId: message.rootMessageId ?? message.messageId, actorOpenId: message.actorOpenId,
      requestedTitle: "Orchestrator", initialPromptText: message.text, agentKind: "traex", projectId: project.id,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    });
    const reserved = store.createOrGetPendingOrchestratorBinding({
      id: selection.bindingId ?? randomUUID(), gatewayId: config.gateway.id, projectId: project.id,
      workspaceId: runtimeProject.workspaceId, chatId: message.chatId,
      title: formatProjectPaneTitle(projectSpaceName(runtimeProject), runtimeProject.cwd, "orchestrator", "TraeX pane"),
      creatorOpenId: message.actorOpenId
    });
    if (!selection.bindingId && reserved.created) {
      selection = store.linkProjectSelectionBinding(selection.id, reserved.binding.id);
      await this.publish(reserved.binding.id, "BindingCreated", "lark", {
        title: reserved.binding.title, agentKind: reserved.binding.agentKind, workspaceId: reserved.binding.workspaceId,
        spaceName: projectSpaceName(project), paneId: null
      });
    }
    const ownsInitialization = selection.bindingId === reserved.binding.id;
    if (!ownsInitialization) {
      store.failProjectSelection(selection.id, `Orchestrator initialization is owned by ${reserved.binding.id}`);
      return { outcome: isActiveBinding(reserved.binding) ? "existing" : "initializing", binding: reserved.binding };
    }
    if (selection.state === "completed") return { outcome: "initialized", binding: reserved.binding, selection };
    try {
      const binding = await this.createSelectedProject(selection, runtimeProject, reserved.created, "orchestrator");
      selection = store.completeProjectSelection(selection.id, binding.id);
      store.audit({ actorOpenId: message.actorOpenId, action: "binding.create.orchestrator", target: binding.id, outcome: "success" });
      return { outcome: "initialized", binding, selection };
    } catch (error) {
      store.pauseProjectSelection(selection.id, errorMessage(error));
      logger.error({ event: "orchestrator-provisioning-paused", err: safeLogError(error), selectionId: selection.id, bindingId: reserved.binding.id, projectId: project.id, outcome: "retry_on_restart" }, "Orchestrator provisioning paused at a recoverable checkpoint");
      return null;
    }
  }

  async shareOrchestratorThread(message: IncomingLarkMessage, binding: Binding): Promise<void> {
    if (!isActiveBinding(binding) || !binding.topicId || !binding.rootMessageId) {
      await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `orchestrator-initializing:${binding.id}:${message.messageId}`, this.options.presentation.requestRejected("Orchestrator 正在初始化，请稍后在群里再次 @Bot 获取固定 Thread 入口。"));
      return;
    }
    await this.options.gatewayEffects.shareConversation({
      conversationId: binding.topicId, rootMessageId: binding.rootMessageId, messageId: message.messageId,
      targetConversationId: message.chatId, purpose: "group-thread"
    });
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "orchestrator.thread.open", target: binding.id, outcome: "shared" });
  }

  async completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null> {
    return this.projectSelection.complete(action, selectionId, projectId);
  }

  async recover(): Promise<void> {
    return this.startupRecovery.recover();
  }

  async discover(pane: HerdrPane, project: ProjectConfig, activate = true): Promise<Binding> {
    const { store, gatewayEffects, lifecycleEvents, config } = this.options;
    const id = randomUUID();
    const title = formatProjectPaneTitle(projectSpaceName(project), pane.cwd, pane.label, pane.paneId);
    const agentKind = agentKindFromPane(pane);
    let binding = store.createPendingBinding({ id, projectId: project.id, workspaceId: pane.workspaceId, chatId: config.lark.chatId, topicId: null, rootMessageId: null, title, agentKind });
    store.revokeBindingPrimaryToolCapability(binding.id, binding.generation);
    binding = transitionBindingPane(store, binding, pane, { type: "pane_created" }, activate ? "observed" : "staged");
    binding = transitionBindingPane(store, binding, pane, { type: "runtime_started" }, activate ? "observed" : "staged");
    const createdEvent = createBridgeEvent(binding.id, "BindingCreated", "herdr", { title, agentKind: binding.agentKind, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null });
    const availabilityEvent = createBridgeEvent(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    const initialView = reduceTopicView(reduceTopicView(initialTopicView(binding.id), createdEvent), availabilityEvent);
    store.saveTopicView(initialView);
    const topic = await gatewayEffects.createConversation({ conversationId: config.lark.chatId, view: this.options.presentation.mainCard(initialView), idempotencyKey: binding.id, purpose: "primary-main" });
    store.recordBridgeMessage(topic.rootMessageId);
    store.saveTopicView({ ...initialView, deliveredVersion: initialView.viewVersion });
    binding = store.updateBindingMetadata(binding.id, { topicId: topic.threadId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId });
    binding = store.transitionBinding(binding.id, { type: "thread_created" });
    if (!activate) { await lifecycleEvents.publish(createdEvent); await lifecycleEvents.publish(availabilityEvent); return binding; }
    binding = store.transitionBinding(binding.id, { type: "activate" });
    await lifecycleEvents.publish(createdEvent);
    await lifecycleEvents.publish(availabilityEvent);
    await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: topic.threadId });
    return binding;
  }

  async reset(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean> {
    const { store, herdr, scheduler, logger } = this.options;
    if (!binding || binding.lifecycle !== "active" || binding.state !== "active" || !["attached", "degraded"].includes(binding.attachment) || !binding.projectId || !binding.topicId || !binding.rootMessageId) {
      await this.reject(message, "`/swarm reset` 只能在已连接且活动中的项目话题内使用。"); return false;
    }
    if (binding.kind === "orchestrator") { await this.reject(message, "Orchestrator 请使用 `/swarm clear` 清理上下文；`/swarm reset` 不会替换固定 Pane。"); return false; }
    const project = this.projects.projectById(binding.projectId);
    if (!project) { await this.reject(message, "当前会话的项目配置已不存在，不能开启新会话。"); return false; }
    const paneToken = createPrimaryPaneToken();
    const displayTitle = requestedTitle?.replace(/\s+/g, " " ).trim() || paneToken;
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, displayTitle, "TraeX pane");
    const candidate = store.createResetCandidate({ oldBindingId: binding.id, newBindingId: randomUUID(), title, actorOpenId: message.actorOpenId, resetMessageId: message.messageId });
    try {
      let replacement = candidate.replacement;
      if (!candidate.created && replacement.provisioningCheckpoint === "selected") throw new Error("Reset candidate may already have created a pane; inspect the Space and attach the surviving pane instead of retrying creation");
      let pane = replacement.paneId ? await herdr.getPane(replacement.paneId) : null;
      if (replacement.provisioningCheckpoint === "selected") {
        const tools = this.primaryToolConfiguration(replacement, true);
        pane = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(replacement.id, replacement.generation, project.id, paneToken, tools));
        replacement = transitionBindingPane(store, replacement, pane, { type: "pane_created" });
      }
      if (!pane) throw new ProvisionedPaneMissingError(replacement.paneId);
      if (replacement.provisioningCheckpoint === "pane_created") {
        const tools = this.primaryToolConfiguration(replacement, false);
        await this.startPrimaryAgent(replacement, pane, tools);
        const startedPane = await this.requireStartedPane(project, pane.paneId, replacement.traexSessionId, replacement.agentKind);
        replacement = transitionBindingPane(store, replacement, startedPane, { type: "runtime_started", runtime: startedPane.agentState });
        pane = startedPane;
      }
      const observedPane = await this.requireStartedPane(project, pane.paneId, replacement.traexSessionId, replacement.agentKind);
      replacement = transitionBindingPane(store, replacement, observedPane, { type: "pane_observed", runtime: observedPane.agentState });
      pane = observedPane;
      const handoff = requireResetCutover(store.applyRuntimeIdentityTransition({ kind: "cutover_reset_candidate", cleanupOperationId: randomUUID(), actorOpenId: message.actorOpenId, expectedCwd: project.cwd, expectedPrevious: runtimeIdentityFence(binding), expectedReplacement: runtimeIdentityFence(replacement) }));
      replacement = handoff.replacement;
      this.options.wakeRetiredPaneCleanup?.();
      scheduler.wake({ kind: "binding-runtime-changed", bindingId: binding.id });
      await this.publish(replacement.id, "BindingCreated", "lark", { title, agentKind: replacement.agentKind, workspaceId: replacement.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null });
      await this.publish(replacement.id, "BindingActivated", "bridge", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: replacement.topicId! });
      await this.publishPrimaryToolAvailability(replacement);
      await this.reply(replacement.rootMessageId!, this.options.presentation.requestRejected(`已开启新会话：${displayPaneIdentity(pane)}。旧 Herdr pane ${displayPaneIdentity(handoff.previous, "(unknown)")} 将在确认空闲后安全关闭。`));
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

  async attach(message: IncomingLarkMessage, spaceName: string | null, paneReference: string): Promise<boolean> {
    return this.attachment.attach(message, spaceName, paneReference);
  }

  async reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void> {
    return this.managedLifecycle.reattach(binding, paneId, actorOpenId);
  }

  async replace(binding: Binding, actorOpenId: string): Promise<void> {
    return this.managedLifecycle.replace(binding, actorOpenId);
  }

  private async createSelectedProject(selection: ProjectSelection, project: ProjectConfig, allowPaneCreation: boolean, fixedPaneTitle?: string): Promise<Binding> {
    const { store, herdr, config, logger } = this.options;
    const bindingId = selection.bindingId ?? randomUUID();
    const paneTitle = fixedPaneTitle ?? createPrimaryPaneToken();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    let binding = selection.bindingId ? store.getBinding(selection.bindingId) : null;
    if (!binding) { binding = store.createPendingBinding({ id: bindingId, projectId: project.id, workspaceId: project.workspaceId, chatId: selection.chatId, topicId: null, rootMessageId: null, title, agentKind: selection.agentKind, creatorOpenId: selection.actorOpenId }); store.linkProjectSelectionBinding(selection.id, binding.id); await this.publish(binding.id, "BindingCreated", "lark", { title, agentKind: binding.agentKind, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: null }); }
    let current = binding;
    try {
      let pane = current.paneId ? await herdr.getPane(current.paneId) : null;
      if (current.paneId && !pane) throw new ProvisionedPaneMissingError(current.paneId);
      if (pane && current.traexSessionId && pane.terminalId && current.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${current.paneId}`);
      const selectedDecision = decideSelectedCheckpoint(current.provisioningCheckpoint, allowPaneCreation);
      if (selectedDecision === "manual_attach") throw new Error("Interrupted while creating the Herdr pane; inspect the Space and attach the surviving pane with /swarm attach <space> <pane>");
      if (selectedDecision === "create_pane") {
        const tools = this.primaryToolConfiguration(current, true);
        if (fixedPaneTitle === "orchestrator") {
          if (!herdr.supportsPaneCreationV2 || !herdr.createPaneV2 || !await herdr.supportsPaneCreationV2()) throw new Error("Herdr does not support tab.create.v2 required for fixed Orchestrator identity");
          const result = await herdr.createPaneV2({ workspaceId: project.workspaceId, expectedWorkspaceLabel: "herdr", token: "orch", cwd: project.cwd, options: paneCreationOptions(current.id, current.generation, project.id, paneTitle, tools) });
          if (result.outcome !== "created") throw new Error(`Fixed Orchestrator Pane creation failed (${result.outcome}): ${result.reason}`);
          if (result.receipt.workspaceId !== project.workspaceId || result.receipt.token !== "orch") throw new Error("Fixed Orchestrator Pane creation returned a mismatched identity receipt");
          pane = {
            paneId: result.receipt.paneId, paneToken: result.receipt.token, tabId: result.receipt.tabId,
            terminalId: result.receipt.terminalId, workspaceId: result.receipt.workspaceId,
            cwd: project.cwd, label: paneTitle, agentState: "idle", foregroundExecutables: []
          };
        } else pane = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(current.id, current.generation, project.id, paneTitle, tools));
        current = transitionBindingPane(store, current, pane, { type: "pane_created" });
      }
      if (!pane && current.paneId) pane = await herdr.getPane(current.paneId);
      if (!pane) throw new Error(`Provisioning checkpoint ${current.provisioningCheckpoint} has no Herdr pane`);
      const hasPrimaryToolCapability = current.agentKind !== "traex" || store.hasBindingPrimaryToolCapability(current.id, current.generation);
      const paneObservation = current.provisioningCheckpoint === "pane_created" && hasPrimaryToolCapability
        ? await herdr.observeRuntime(pane.paneId)
        : null;
      const paneCreatedDecision = current.agentKind === "traex" ? decidePaneCreatedCheckpoint({
        checkpoint: current.provisioningCheckpoint,
        hasPrimaryToolCapability,
        ...(paneObservation?.processProbe ? { processProbe: paneObservation.processProbe } : {}),
        traexProcess: paneObservation?.traexProcess ?? false,
        composerReady: paneObservation?.composerReady ?? false
      }) : current.provisioningCheckpoint === "pane_created" ? "start_runtime" : "continue";
      if (paneCreatedDecision === "reject_missing_capability") {
          await this.publish(current.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
          throw new Error("Primary tool credential provenance is unavailable; use /swarm reset or /swarm replace");
      }
      if (paneCreatedDecision === "pause_process_probe_unavailable") {
        throw new Error(`Herdr process probe is unavailable for pane ${pane.paneId}; refusing automatic runtime start or replacement until observation recovers`);
      }
      if (paneCreatedDecision === "replace_pane") {
        if (fixedPaneTitle === "orchestrator") throw new Error("Fixed Orchestrator Pane is not safely reusable; refusing automatic-token replacement");
        const replacementTitle = createPrimaryPaneToken();
        const tools = this.primaryToolConfiguration({ ...current, generation: current.generation + 1 }, true);
        const replacement = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(current.id, current.generation + 1, project.id, replacementTitle, tools));
        current = requireBindingUpdate(store.applyRuntimeIdentityTransition({ kind: "replace_provisioning_pane", expected: runtimeIdentityFence(current), pane: replacement }));
        pane = replacement;
        logger.warn({ event: "project-provisioning-pane-replaced", selectionId: selection.id, bindingId: current.id, retainedPaneId: paneObservation?.pane?.paneId ?? null, paneId: pane.paneId, generation: current.generation, outcome: "replacement_created" }, "replaced an occupied provisioning pane that lacked structured Agent readiness");
      }
      if (paneCreatedDecision === "start_runtime" || paneCreatedDecision === "replace_pane") {
        const tools = this.primaryToolConfiguration(current, false);
        await this.startPrimaryAgent(current, pane, tools);
        pane = await this.requireStartedPane(project, pane.paneId, current.traexSessionId, current.agentKind);
        current = transitionBindingPane(store, current, pane, { type: "runtime_started", runtime: pane.agentState });
      }
      const activatedEvent = createBridgeEvent(current.id, "BindingActivated", "bridge", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: "pending" });
      let activeView = reduceTopicView(store.loadTopicView(current.id) ?? { ...initialTopicView(current.id), title: current.title, agentKind: current.agentKind, workspaceId: current.workspaceId, spaceName: projectSpaceName(project), paneId: pane.paneId }, activatedEvent);
      if (current.agentKind !== "traex") activeView = reduceTopicView(activeView, createBridgeEvent(current.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: `${current.agentKind} Primary 当前不支持 Bridge Primary 工具；请直接通过飞书命令管理 Worker。` }));
      if (current.provisioningCheckpoint === "runtime_started") { const topic = await this.options.gatewayEffects.createConversation({ conversationId: config.lark.chatId, view: this.options.presentation.mainCard(activeView), idempotencyKey: current.id, purpose: "primary-main" }); store.recordBridgeMessage(topic.rootMessageId); store.saveTopicView({ ...activeView, deliveredVersion: activeView.viewVersion }); current = store.updateBindingMetadata(current.id, { topicId: topic.threadId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId }); current = store.transitionBinding(current.id, { type: "thread_created" }); }
      if (current.provisioningCheckpoint === "thread_created") current = store.transitionBinding(current.id, { type: "activate" });
      await this.publish(current.id, "BindingActivated", "bridge", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: current.topicId! });
      await this.publishPrimaryToolAvailability(current); return current;
    } catch (error) { logger.warn({ event: "project-provisioning-paused", err: safeLogError(error), selectionId: selection.id, bindingId: current.id, checkpoint: current.provisioningCheckpoint, outcome: "retry_on_restart" }, "project provisioning paused at a durable checkpoint"); throw error; }
  }

  private async resolveOrchestratorProject(project: ProjectConfig): Promise<ProjectConfig> {
    const { herdr } = this.options;
    if (!herdr.listWorkspaces) throw new Error("Herdr does not support fresh Workspace discovery");
    if (!herdr.supportsPaneCreationV2 || !herdr.createPaneV2 || !await herdr.supportsPaneCreationV2()) throw new Error("Herdr does not support tab.create.v2 required for fixed Orchestrator identity");
    const matches = (await herdr.listWorkspaces()).filter((workspace) => workspace.label === "herdr");
    if (matches.length !== 1) throw new Error(`Expected exactly one Herdr Space labeled 'herdr', found ${matches.length}`);
    return { ...project, workspaceId: matches[0]!.workspaceId, spaceName: "herdr", cwd: project.orchestrator!.cwd };
  }

  private async startPrimaryAgent(binding: Binding, pane: HerdrPane, tools: PrimaryToolConfiguration): Promise<void> {
    const driver = this.options.agentDrivers?.get(binding.agentKind);
    if (!driver) {
      if (binding.agentKind !== "traex") throw new Error(`Agent adapter is unavailable: ${binding.agentKind}`);
      if (this.options.herdr.startAgent) await this.options.herdr.startAgent(pane.paneId, {
        name: primaryManagedAgentName(binding.projectId, binding.id, binding.generation), kind: "traex",
        executable: this.options.config.traex.executable, args: primaryToolAgentArgs(tools), rotatable: binding.kind === "orchestrator"
      });
      else await this.options.herdr.startTraex(pane.paneId, this.options.config.traex.executable, primaryToolAgentArgs(tools));
      return;
    }
    if (!driver.describe().available) throw new Error(`Agent adapter is unavailable: ${binding.agentKind}`);
    await driver.start({ herdrWorkspaceId: binding.workspaceId, paneId: pane.paneId, nativeSessionId: null, generation: binding.generation }, { ...(binding.projectId ? { projectId: binding.projectId } : {}), name: "primary", managedName: primaryManagedAgentName(binding.projectId, binding.id, binding.generation), model: null, transcriptOwnerId: binding.id, rotatable: binding.kind === "orchestrator", ...(binding.agentKind === "traex" ? { primaryTools: tools } : {}) });
  }

  private primaryToolConfiguration(binding: Pick<Binding, "id" | "generation" | "agentKind">, issue: boolean): PrimaryToolConfiguration {
    if (binding.agentKind !== "traex") return { environment: {}, command: "", args: [] };
    return issue ? this.options.primaryTools.issueBinding(binding.id, binding.generation) : this.options.primaryTools.configurationForBinding(binding.id, binding.generation);
  }

  private publishPrimaryToolAvailability(binding: Binding): Promise<void> {
    return this.publish(binding.id, "PrimaryToolAvailabilityChanged", "bridge", binding.agentKind === "traex"
      ? { available: true, reason: null }
      : { available: false, reason: `${binding.agentKind} Primary 当前不支持 Bridge Primary 工具；请直接通过飞书命令管理 Worker。` });
  }

  private async requireStartedPane(project: ProjectConfig, paneId: string, expectedTerminalId: string | null, agentKind: AgentKind = "traex"): Promise<HerdrPane> {
    const observation = await this.options.herdr.observeRuntime(paneId);
    const pane = observation.pane;
    if (!pane || !matchesPaneAgentKind(agentKind, pane) || pane.workspaceId !== project.workspaceId || pane.cwd !== project.cwd || !pane.terminalId) {
      throw new Error(`${agentKind} runtime in pane ${paneId} is not ready`);
    }
    if (expectedTerminalId && pane.terminalId !== expectedTerminalId) throw new Error(`Herdr pane identity changed for ${paneId}`);
    return pane;
  }

  private async publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean, resumeRequired = false, toolsUnavailable = !this.options.store.hasBindingPrimaryToolCapability(binding.id, binding.generation)): Promise<void> {
    if (!binding.paneId) return;
    if (toolsUnavailable) await this.publish(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `attach:${message.messageId}:${alreadyAttached ? "existing" : "created"}`, this.options.presentation.attachStatus({ spaceName, paneId: binding.paneId, paneToken: binding.paneToken, ...(binding.rootMessageId ? { bindingId: binding.id } : {}), alreadyAttached, resumeRequired }));
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, contentIdempotencyKey(`standalone:${rootMessageId}`, card), card); }
  private async publish(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload) as ReturnType<typeof createBridgeEvent>); }
}

function agentKindFromPane(pane: HerdrPane): AgentKind {
  const kind = agentKindFromHerdr(pane.agentKind);
  if (kind) return kind;
  // Legacy Herdr snapshots predate structured agentKind but still expose the
  // TraeX foreground executable. Other Agent kinds require structured identity.
  if (pane.foregroundExecutables.includes("traex")) return "traex";
  throw new Error(`Herdr pane ${pane.paneId} has no supported Agent kind`);
}
function matchesPaneAgentKind(kind: AgentKind, pane: HerdrPane): boolean {
  return kind === "traex" ? pane.foregroundExecutables.includes("traex") || pane.agentKind === "traex" : matchesAgentKind(kind, pane.agentKind);
}

function transitionBindingPane(store: BindingProvisioningStore, binding: Binding, pane: HerdrPane, transition: Parameters<BindingProvisioningStore["transitionBinding"]>[1], projection: "observed" | "staged" = "observed"): Binding {
  return requireBindingUpdate(store.applyRuntimeIdentityTransition({ kind: projection === "staged" ? "stage_binding_pane" : "observe_binding_pane", expected: runtimeIdentityFence(binding), pane, transition }));
}
function requireBindingUpdate(result: RuntimeIdentityTransitionApplication): Binding {
  if (result.outcome !== "binding_updated") throw new Error(`Expected Binding identity update, received ${result.outcome}`);
  return result.binding;
}
function requireResetCutover(result: RuntimeIdentityTransitionApplication) {
  if (result.outcome !== "reset_cutover") throw new Error(`Expected reset identity cutover, received ${result.outcome}`);
  return result;
}
function runtimeIdentityFence(binding: Binding): RuntimeIdentityTransitionFence {
  return {
    owner: { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch },
    workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId, attachment: binding.attachment,
    nativeIdentity: binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
      : null
  };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isActiveBinding(binding: Binding): boolean { return binding.state === "active" && binding.lifecycle === "active"; }
