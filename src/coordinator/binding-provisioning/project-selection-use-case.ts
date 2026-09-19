import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { projectSpaceName } from "../../config.js";
import type { BindingProvisioningStore } from "../../domain/ports/binding.js";
import type { ImmediateOutboundDispatcher, OutboundIntentPort } from "../../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../../domain/ports/presentation.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig, ProjectSelection } from "../../domain/types.js";
import type { OutboundWorkNotifier } from "../../events/outbound-work-notifier.js";
import { safeLogError } from "../../runtime/safe-error.js";
import { provisioningRecoveryMessage } from "../binding-provisioning-policy.js";
import { ProjectCatalog } from "../project-catalog.js";
import type { AgentKind } from "../../domain/agent-instance.js";

type StatusInput = Parameters<ApplicationPresentation["projectSelectionStatus"]>[0];

export class ProjectSelectionUseCase {
  private readonly projects: ProjectCatalog;
  constructor(private readonly options: { projects: readonly ProjectConfig[]; store: BindingProvisioningStore; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; immediateOutbound: ImmediateOutboundDispatcher; logger: Logger; presentation: Pick<ApplicationPresentation, "projectSelector" | "projectSelectionStatus">; provision(selection: ProjectSelection, project: ProjectConfig, allowPaneCreation: boolean): Promise<Binding> }) { this.projects = new ProjectCatalog(options.projects); }

  async begin(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText: string | null, agentKind: AgentKind): Promise<void> {
    const selectionId = randomUUID();
    this.options.store.createProjectSelection({ id: selectionId, commandMessageId: message.messageId, chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId ?? message.messageId, actorOpenId: message.actorOpenId, requestedTitle, initialPromptText, agentKind, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), card: this.options.presentation.projectSelector({ selectionId, projects: [...this.options.projects] }) });
    this.options.outboundWork.wake();
    try { await this.options.immediateOutbound.requestScan(); }
    catch (error) { this.options.logger.warn({ event: "project-selector-immediate-delivery-failed", err: safeLogError(error), selectionId, eventId: message.eventId, outcome: "deferred" }, "immediate project selector delivery failed; durable outbox retry remains scheduled"); }
  }

  async beginDefault(message: IncomingLarkMessage, requestedTitle: string | null, initialPromptText: string | null, agentKind: AgentKind, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null> {
    const project = this.projects.projectById(projectId);
    if (!project) throw new Error(`Default project is not configured: ${projectId}`);
    let selection = this.options.store.createAutomaticProjectSelection({ id: randomUUID(), commandMessageId: message.messageId, chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId ?? message.messageId, actorOpenId: message.actorOpenId, requestedTitle, initialPromptText, agentKind, projectId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (selection.selectedProjectId !== projectId || selection.chatId !== message.chatId || selection.actorOpenId !== message.actorOpenId) throw new Error("Automatic project selection identity conflicts with the persisted source message");
    if (selection.state === "completed") {
      const binding = selection.bindingId ? this.options.store.getBinding(selection.bindingId) : null;
      return binding ? { binding, selection } : null;
    }
    if (selection.state !== "processing") return null;
    try {
      const binding = await this.options.provision(selection, project, selection.bindingId === null);
      selection = this.options.store.completeProjectSelection(selection.id, binding.id);
      this.options.store.audit({ actorOpenId: message.actorOpenId, action: "binding.create.default", target: binding.id, outcome: "success" });
      return { binding, selection };
    } catch (error) {
      this.options.store.pauseProjectSelection(selection.id, errorMessage(error));
      this.options.logger.error({ event: "default-project-selection-paused", err: safeLogError(error), selectionId: selection.id, projectId, outcome: "retry_on_restart" }, "default project provisioning paused at a recoverable checkpoint");
      return null;
    }
  }

  async complete(action: IncomingLarkCardAction, selectionId: string, projectId: string): Promise<{ binding: Binding; selection: ProjectSelection } | null> {
    const claim = this.options.store.claimProjectSelection({ selectionId, projectId, messageId: action.messageId, chatId: action.chatId, actorOpenId: action.operatorOpenId, allowedProjectIds: this.options.projects.map((project) => project.id) });
    this.options.logger.info({ event: "project-selection-decided", selectionId, projectId, messageId: action.messageId, outcome: claim.outcome }, "processed project selection action");
    this.options.store.audit({ actorOpenId: action.operatorOpenId, action: "project.select", target: `${selectionId}:${projectId}`, outcome: claim.outcome });
    if (!claim.selection || ["missing", "invalid", "unauthorized", "processing"].includes(claim.outcome)) return null;
    if (claim.outcome === "expired") { await this.status(action.messageId, selectionId, { status: "expired", message: "请重新发送 /swarm new。" }); return null; }
    const selection = claim.selection;
    if (claim.outcome === "completed") {
      const binding = selection.bindingId ? this.options.store.getBinding(selection.bindingId) : null;
      const project = selection.selectedProjectId ? this.projects.projectById(selection.selectedProjectId) : undefined;
      if (!binding || !project) return null;
      await this.success(selection.id, action.messageId, project, binding);
      return { binding, selection };
    }
    const project = this.projects.projectById(projectId);
    if (!project) return null;
    await this.status(action.messageId, selectionId, { status: "processing", projectName: project.displayName, spaceName: projectSpaceName(project) });
    try {
      const binding = await this.options.provision(selection, project, true);
      const completed = this.options.store.completeProjectSelection(selection.id, binding.id);
      await this.success(selection.id, action.messageId, project, binding);
      this.options.store.audit({ actorOpenId: action.operatorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
      return { binding, selection: completed };
    } catch (error) {
      this.options.store.pauseProjectSelection(selection.id, errorMessage(error));
      await this.status(action.messageId, selectionId, { status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project), message: provisioningRecoveryMessage(error) });
      this.options.logger.error({ event: "project-selection-paused", err: safeLogError(error), selectionId, projectId, outcome: "retry_on_restart" }, "project selection paused at a recoverable checkpoint");
      return null;
    }
  }

  async recover(selection: ProjectSelection): Promise<void> {
    const project = selection.selectedProjectId ? this.projects.projectById(selection.selectedProjectId) ?? null : null;
    const automaticBeforePane = !selection.bindingId && !selection.selectorMessageId && project;
    if ((!selection.bindingId && !automaticBeforePane) || !project) { this.options.store.failProjectSelection(selection.id, "Interrupted before recoverable project identity was persisted"); return; }
    try {
      const binding = await this.options.provision(selection, project, Boolean(automaticBeforePane));
      this.options.store.completeProjectSelection(selection.id, binding.id);
      if (selection.selectorMessageId) await this.success(selection.id, selection.selectorMessageId, project, binding);
      this.options.logger.info({ event: "project-selection-recovered", selectionId: selection.id, bindingId: binding.id, paneId: binding.paneId, outcome: "completed" }, "resumed interrupted project provisioning");
    } catch (error) {
      if (error instanceof ProvisionedPaneMissingError) {
        const binding = selection.bindingId ? this.options.store.getBinding(selection.bindingId) : null;
        if (binding?.lifecycle === "provisioning") this.options.store.transitionBinding(binding.id, { type: "provisioning_failed" });
        this.options.store.failProjectSelection(selection.id, error.message);
        if (selection.selectorMessageId) await this.status(selection.selectorMessageId, selection.id, { status: "failed", projectName: project.displayName, spaceName: projectSpaceName(project), message: error.message });
        this.options.logger.error({ event: "project-selection-recovery-failed", err: safeLogError(error), selectionId: selection.id, bindingId: selection.bindingId, outcome: "failed_missing_pane" }, "project provisioning cannot resume because its pane no longer exists");
        return;
      }
      this.options.store.pauseProjectSelection(selection.id, errorMessage(error));
      if (selection.selectorMessageId) await this.status(selection.selectorMessageId, selection.id, { status: "recoverable", projectName: project.displayName, spaceName: projectSpaceName(project), message: errorMessage(error) });
      this.options.logger.error({ event: "project-selection-recovery-failed", err: safeLogError(error), selectionId: selection.id, bindingId: selection.bindingId, outcome: "retry_on_restart" }, "project provisioning remains recoverable");
    }
  }

  success(selectionId: string, messageId: string, project: ProjectConfig, binding: Binding): Promise<void> { return this.status(messageId, selectionId, { status: "completed", projectName: project.displayName, spaceName: projectSpaceName(project), ...(binding.rootMessageId ? { bindingId: binding.id } : {}), ...(binding.paneId ? { paneId: binding.paneId } : {}) }); }
  private status(messageId: string, selectionId: string, input: StatusInput): Promise<void> { return this.options.outbound.enqueueCardUpdate(null, messageId, `selection:${selectionId}:${input.status}`, this.options.presentation.projectSelectionStatus(input)); }
}

export class ProvisionedPaneMissingError extends Error { constructor(paneId: string | null) { super(`Provisioned Herdr pane ${paneId ?? "unknown"} no longer exists`); this.name = "ProvisionedPaneMissingError"; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
