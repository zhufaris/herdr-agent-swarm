import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { GatewayEffectPort } from "../gateways/effect-client.js";
import type { ImmediateOutboundDispatcher, OutboundIntentPort } from "../domain/ports/outbox.js";
import type { BindingProvisioningStore } from "../domain/ports/binding.js";
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
import { ProjectCatalog } from "./project-catalog.js";

export interface BindingProvisioningWorkflowPort {
  selectProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText?: string | null): Promise<void>;
  completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null>;
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
  gatewayEffects: GatewayEffectPort;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  immediateOutbound: ImmediateOutboundDispatcher;
  scheduler: PromptWorkScheduler;
  primaryTools: {
    issueBinding(bindingId: string, expectedGeneration: number): PrimaryToolConfiguration;
    configurationForBinding(bindingId: string, generation: number): PrimaryToolConfiguration;
  };
  wakeRetiredPaneCleanup?: () => void;
  logger: Logger;
  presentation: Pick<ApplicationPresentation, "projectSelector" | "projectSelectionStatus" | "attachStatus" | "mainCard" | "requestRejected">;
}

export class BindingProvisioningWorkflow implements BindingProvisioningWorkflowPort {
  private readonly projects: ProjectCatalog;
  private readonly managedLifecycle: ManagedBindingLifecycle;
  private readonly projectSelection: ProjectSelectionUseCase;
  private readonly attachment: BindingAttachmentUseCase;
  private readonly startupRecovery: BindingStartupRecovery;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
    this.managedLifecycle = new ManagedBindingLifecycle({
      config: options.config, store: options.store, herdr: options.herdr, projects: this.projects, primaryTools: options.primaryTools,
      requireStartedPane: (project, paneId, terminalId) => this.requireStartedPane(project, paneId, terminalId),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3])
    });
    this.projectSelection = new ProjectSelectionUseCase({ projects: options.config.projects, store: options.store, outbound: options.outbound, outboundWork: options.outboundWork, immediateOutbound: options.immediateOutbound, logger: options.logger, presentation: options.presentation, provision: (selection, project, allowPaneCreation) => this.createSelectedProject(selection, project, allowPaneCreation) });
    this.attachment = new BindingAttachmentUseCase({
      config: options.config, store: options.store, herdr: options.herdr, projects: this.projects, scheduler: options.scheduler,
      ...(options.wakeRetiredPaneCleanup ? { wakeRetiredPaneCleanup: options.wakeRetiredPaneCleanup } : {}),
      createSelectedProject: (selection, project, allowPaneCreation) => this.createSelectedProject(selection, project, allowPaneCreation),
      discover: (pane, project) => this.discover(pane, project),
      publishSelectionSuccess: (selectionId, messageId, project, binding) => this.projectSelection.success(selectionId, messageId, project, binding),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3]),
      publishAttachSuccess: (message, binding, spaceName, alreadyAttached, resumeRequired, toolsUnavailable) => this.publishAttachSuccess(message, binding, spaceName, alreadyAttached, resumeRequired, toolsUnavailable),
      reject: (message, reason) => this.reject(message, reason)
    });
    this.startupRecovery = new BindingStartupRecovery({ store: options.store, herdr: options.herdr, gatewayEffects: options.gatewayEffects, logger: options.logger, projects: this.projects, lifecycleEvents: options.lifecycleEvents, presentation: options.presentation, recoverSelection: (selection) => this.projectSelection.recover(selection), publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload as Parameters<typeof createBridgeEvent>[3]) });
  }

  async selectProject(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText: string | null = null): Promise<void> {
    return this.projectSelection.begin(message, requestedTitle, initialPromptText);
  }

  async completeSelection(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null> {
    return this.projectSelection.complete(action, selectionId, projectId);
  }

  async recover(): Promise<void> {
    return this.startupRecovery.recover();
  }

  async discover(pane: HerdrPane, project: ProjectConfig): Promise<Binding> {
    const { store, gatewayEffects, lifecycleEvents, config } = this.options;
    const id = randomUUID();
    const title = formatProjectPaneTitle(projectSpaceName(project), pane.cwd, pane.label, pane.paneId);
    let binding = store.createPendingBinding({ id, projectId: project.id, workspaceId: pane.workspaceId, chatId: config.lark.chatId, topicId: null, rootMessageId: null, title });
    store.revokeBindingPrimaryToolCapability(binding.id, binding.generation);
    binding = store.updateBindingMetadata(binding.id, paneIdentityPatch(pane));
    binding = store.transitionBinding(binding.id, { type: "pane_created" });
    binding = store.transitionBinding(binding.id, { type: "runtime_started" });
    const createdEvent = createBridgeEvent(binding.id, "BindingCreated", "herdr", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId });
    const availabilityEvent = createBridgeEvent(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    const initialView = reduceTopicView(reduceTopicView(initialTopicView(binding.id), createdEvent), availabilityEvent);
    store.saveTopicView(initialView);
    const topic = await gatewayEffects.createConversation({ conversationId: config.lark.chatId, view: this.options.presentation.mainCard(initialView), idempotencyKey: binding.id, purpose: "primary-main" });
    store.recordBridgeMessage(topic.rootMessageId);
    store.saveTopicView({ ...initialView, deliveredVersion: initialView.viewVersion });
    binding = store.updateBindingMetadata(binding.id, { topicId: topic.threadId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId });
    binding = store.transitionBinding(binding.id, { type: "thread_created" });
    binding = store.transitionBinding(binding.id, { type: "activate" });
    await lifecycleEvents.publish(createdEvent);
    await lifecycleEvents.publish(availabilityEvent);
    await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: topic.threadId });
    return binding;
  }

  async reset(message: IncomingLarkMessage, binding: Binding | null, requestedTitle: string | null): Promise<boolean> {
    const { store, config, herdr, scheduler, logger } = this.options;
    if (!binding || binding.lifecycle !== "active" || binding.state !== "active" || !["attached", "degraded"].includes(binding.attachment) || !binding.projectId || !binding.topicId || !binding.rootMessageId) {
      await this.reject(message, "`/swarm reset` 只能在已连接且活动中的项目话题内使用。"); return false;
    }
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
        const tools = this.options.primaryTools.issueBinding(replacement.id, replacement.generation);
        pane = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(replacement.id, replacement.generation, project.id, paneToken, tools));
        replacement = store.updateBindingMetadata(replacement.id, paneIdentityPatch(pane));
        replacement = store.transitionBinding(replacement.id, { type: "pane_created" });
      }
      if (!pane) throw new ProvisionedPaneMissingError(replacement.paneId);
      if (replacement.provisioningCheckpoint === "pane_created") {
        const tools = this.options.primaryTools.configurationForBinding(replacement.id, replacement.generation);
        await herdr.startTraex(pane.paneId, config.traex.executable, primaryToolAgentArgs(tools));
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
      await this.publish(replacement.id, "PrimaryToolAvailabilityChanged", "bridge", { available: true, reason: null });
      await this.reply(replacement.rootMessageId!, this.options.presentation.requestRejected(`已开启新会话：${pane.paneId}。旧 Herdr pane ${handoff.previous.paneId ?? "(unknown)"} 将在确认空闲后安全关闭。`));
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
    return this.attachment.attach(message, spaceName, paneReference);
  }

  async reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void> {
    return this.managedLifecycle.reattach(binding, paneId, actorOpenId);
  }

  async replace(binding: Binding, actorOpenId: string): Promise<void> {
    return this.managedLifecycle.replace(binding, actorOpenId);
  }

  private async createSelectedProject(selection: ProjectSelection, project: ProjectConfig, allowPaneCreation: boolean): Promise<Binding> {
    const { store, herdr, config, logger } = this.options;
    const bindingId = selection.bindingId ?? randomUUID();
    const paneTitle = createPrimaryPaneToken();
    const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
    let binding = selection.bindingId ? store.getBinding(selection.bindingId) : null;
    if (!binding) { binding = store.createPendingBinding({ id: bindingId, projectId: project.id, workspaceId: project.workspaceId, chatId: selection.chatId, topicId: null, rootMessageId: null, title, creatorOpenId: selection.actorOpenId }); store.linkProjectSelectionBinding(selection.id, binding.id); await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: null }); }
    let current = binding;
    try {
      let pane = current.paneId ? await herdr.getPane(current.paneId) : null;
      if (current.paneId && !pane) throw new ProvisionedPaneMissingError(current.paneId);
      if (pane && current.traexSessionId && pane.terminalId && current.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${current.paneId}`);
      const selectedDecision = decideSelectedCheckpoint(current.provisioningCheckpoint, allowPaneCreation);
      if (selectedDecision === "manual_attach") throw new Error("Interrupted while creating the Herdr pane; inspect the Space and attach the surviving pane with /swarm attach <space> <pane>");
      if (selectedDecision === "create_pane") {
        const tools = this.options.primaryTools.issueBinding(current.id, current.generation);
        pane = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(current.id, current.generation, project.id, paneTitle, tools));
        current = store.updateBindingMetadata(current.id, paneIdentityPatch(pane)); current = store.transitionBinding(current.id, { type: "pane_created" });
      }
      if (!pane && current.paneId) pane = await herdr.getPane(current.paneId);
      if (!pane) throw new Error(`Provisioning checkpoint ${current.provisioningCheckpoint} has no Herdr pane`);
      const hasPrimaryToolCapability = store.hasBindingPrimaryToolCapability(current.id, current.generation);
      const paneObservation = current.provisioningCheckpoint === "pane_created" && hasPrimaryToolCapability
        ? await herdr.observeRuntime(pane.paneId)
        : null;
      const paneCreatedDecision = decidePaneCreatedCheckpoint({
        checkpoint: current.provisioningCheckpoint,
        hasPrimaryToolCapability,
        traexProcess: paneObservation?.traexProcess ?? false,
        composerReady: paneObservation?.composerReady ?? false
      });
      if (paneCreatedDecision === "reject_missing_capability") {
          await this.publish(current.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
          throw new Error("Primary tool credential provenance is unavailable; use /swarm reset or /swarm replace");
      }
      if (paneCreatedDecision === "replace_pane") {
        const replacementTitle = createPrimaryPaneToken();
        const tools = this.options.primaryTools.issueBinding(current.id, current.generation + 1);
        const replacement = await herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(current.id, current.generation + 1, project.id, replacementTitle, tools));
        current = store.replaceProvisioningPane({ bindingId: current.id, expectedPaneId: pane.paneId, expectedGeneration: current.generation, pane: replacement });
        pane = replacement;
        logger.warn({ event: "project-provisioning-pane-replaced", selectionId: selection.id, bindingId: current.id, retainedPaneId: paneObservation?.pane?.paneId ?? null, paneId: pane.paneId, generation: current.generation, outcome: "replacement_created" }, "replaced an occupied provisioning pane that lacked structured Agent readiness");
      }
      if (paneCreatedDecision === "start_runtime" || paneCreatedDecision === "replace_pane") {
        const tools = this.options.primaryTools.configurationForBinding(current.id, current.generation);
        await herdr.startTraex(pane.paneId, config.traex.executable, primaryToolAgentArgs(tools));
        pane = await this.requireStartedPane(project, pane.paneId, current.traexSessionId);
        current = store.updateBindingMetadata(current.id, paneIdentityPatch(pane));
        current = store.transitionBinding(current.id, { type: "runtime_started", runtime: pane.agentState });
      }
      const activatedEvent = createBridgeEvent(current.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: "pending" });
      const activeView = reduceTopicView(store.loadTopicView(current.id) ?? initialTopicView(current.id), activatedEvent);
      if (current.provisioningCheckpoint === "runtime_started") { const topic = await this.options.gatewayEffects.createConversation({ conversationId: config.lark.chatId, view: this.options.presentation.mainCard(activeView), idempotencyKey: current.id, purpose: "primary-main" }); store.recordBridgeMessage(topic.rootMessageId); store.saveTopicView({ ...activeView, deliveredVersion: activeView.viewVersion }); current = store.updateBindingMetadata(current.id, { topicId: topic.threadId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId }); current = store.transitionBinding(current.id, { type: "thread_created" }); }
      if (current.provisioningCheckpoint === "thread_created") current = store.transitionBinding(current.id, { type: "activate" });
      await this.publish(current.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: current.topicId! });
      await this.publish(current.id, "PrimaryToolAvailabilityChanged", "bridge", { available: true, reason: null }); return current;
    } catch (error) { logger.warn({ event: "project-provisioning-paused", err: safeLogError(error), selectionId: selection.id, bindingId: current.id, checkpoint: current.provisioningCheckpoint, outcome: "retry_on_restart" }, "project provisioning paused at a durable checkpoint"); throw error; }
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

  private async publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean, resumeRequired = false, toolsUnavailable = !this.options.store.hasBindingPrimaryToolCapability(binding.id, binding.generation)): Promise<void> {
    if (!binding.paneId) return;
    if (toolsUnavailable) await this.publish(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `attach:${message.messageId}:${alreadyAttached ? "existing" : "created"}`, this.options.presentation.attachStatus({ spaceName, paneId: binding.paneId, ...(binding.rootMessageId ? { bindingId: binding.id } : {}), alreadyAttached, resumeRequired }));
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
