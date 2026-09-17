import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../../config.js";
import type { BindingProvisioningStore } from "../../domain/ports/binding.js";
import type { HerdrPort } from "../../domain/ports/external.js";
import type { Binding, HerdrPane, IncomingLarkMessage, ProjectConfig, ProjectSelection } from "../../domain/types.js";
import type { PromptWorkScheduler } from "../../events/prompt-work-scheduler.js";
import { canonicalPrimaryPaneToken } from "../../domain/pane-title.js";
import { requireMatchingPane } from "../pane-runtime-identity.js";
import type { ProjectCatalog } from "../project-catalog.js";
import { agentKindFromHerdr } from "../../domain/agent-instance.js";

export class BindingAttachmentUseCase {
  constructor(private readonly options: {
    config: BridgeConfig; store: BindingProvisioningStore; herdr: HerdrPort; projects: ProjectCatalog; scheduler: PromptWorkScheduler;
    wakeRetiredPaneCleanup?: () => void;
    createSelectedProject(selection: ProjectSelection, project: ProjectConfig, allowPaneCreation: boolean): Promise<Binding>;
    discover(pane: HerdrPane, project: ProjectConfig): Promise<Binding>;
    publishSelectionSuccess(selectionId: string, selectorMessageId: string, project: ProjectConfig, binding: Binding): Promise<void>;
    publish(bindingId: string, type: "BindingActivated" | "BindingArchived" | "PrimaryToolAvailabilityChanged", origin: "lark" | "bridge", payload: Record<string, unknown>): Promise<void>;
    publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean, resumeRequired?: boolean, toolsUnavailable?: boolean): Promise<void>;
    reject(message: IncomingLarkMessage, reason: string): Promise<void>;
  }) {}

  async attach(message: IncomingLarkMessage, spaceName: string, paneReference: string): Promise<boolean> {
    const { config, store, herdr } = this.options; const projects = this.options.projects.projectsForExplicitSpaceName(spaceName);
    if (projects.length !== 1) { await this.options.reject(message, projects.length === 0 ? `未找到空间 ${spaceName}。` : `空间 ${spaceName} 对应多个项目，无法确定要连接哪一个。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: projects.length === 0 ? "unknown_space" : "ambiguous_space" }); return false; }
    const project = projects[0]!; const panes = (await herdr.listPanes(project.workspaceId, { forceRefresh: true })).filter((candidate) => candidate.workspaceId === project.workspaceId); const exactId = panes.find((candidate) => candidate.paneId === paneReference); const labelMatches = exactId ? [] : panes.filter((candidate) => candidate.label === paneReference);
    if (!exactId && labelMatches.length > 1) { await this.options.reject(message, `Pane 名称 ${paneReference} 不唯一，请改用 Pane ID：${labelMatches.map((candidate) => candidate.paneId).sort().join(", ")}`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_label" }); return false; }
    const tokenMatches = exactId || labelMatches.length > 0 || !/^[a-z0-9]{4}$/i.test(paneReference) ? [] : panes.filter((candidate) => canonicalPrimaryPaneToken(candidate.label) === paneReference.toLowerCase());
    if (tokenMatches.length > 1) { await this.options.reject(message, `Pane token ${paneReference} 不唯一，请改用 Pane ID：${tokenMatches.map((candidate) => candidate.paneId).sort().join(", ")}`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_token" }); return false; }
    const pane = exactId ?? labelMatches[0] ?? tokenMatches[0];
    if (!pane) { await this.options.reject(message, `在空间 ${spaceName} 的 Herdr workspace ${project.workspaceId} 中未找到 Pane ${paneReference}。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "pane_not_found" }); return false; }
    const existing = store.findBindingByPane(pane.paneId);
    if (existing) {
      if (this.isRecoverableFailedReset(existing, message, project)) { const recovered = await this.recoverFailedResetBinding(existing, pane, message.actorOpenId); await this.options.publishAttachSuccess(message, recovered, spaceName, false, false, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.attachment === "orphaned" && existing.topicId && existing.rootMessageId) { const observedPane = await requireMatchingPane(herdr, this.options.projects, existing, pane.paneId); const recovered = store.attachBindingPane(existing.id, observedPane, false); await this.options.publish(recovered.id, "BindingArchived", "lark", { reason: "Pane 已验证并恢复连接；为避免重放不确定任务，请进入原话题发送 `/swarm resume` 后再继续队列。" }); await this.options.publishAttachSuccess(message, recovered, spaceName, true, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_orphaned" }); return true; }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.state === "active") { const toolsUnavailable = !store.hasBindingPrimaryToolCapability(existing.id, existing.generation); if (!toolsUnavailable) await this.options.publish(existing.id, "PrimaryToolAvailabilityChanged", "bridge", { available: true, reason: null }); await this.options.publishAttachSuccess(message, existing, spaceName, true, false, toolsUnavailable); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "already_attached" }); return true; }
      await this.options.reject(message, `Pane ${pane.paneId} 已绑定到其他会话，不能在这里重新连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "bound_elsewhere" }); return false;
    }
    if (!agentKindFromHerdr(pane.agentKind) && !pane.foregroundExecutables.includes("traex")) { await this.options.reject(message, `Pane ${pane.paneId} 当前没有可识别的受支持 Agent，未执行连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: pane.paneId, outcome: "agent_not_running" }); return false; }
    const topicBinding = store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (topicBinding && this.isRecoverableFailedReset(topicBinding, message, project)) { const recovered = await this.recoverFailedResetBinding(topicBinding, pane, message.actorOpenId); await this.options.publishAttachSuccess(message, recovered, spaceName, false, false, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
    const interrupted = store.listProcessingProjectSelections().filter((selection) => selection.bindingId && selection.selectedProjectId === project.id && store.getBinding(selection.bindingId)?.provisioningCheckpoint === "selected");
    if (interrupted.length === 1) { const selection = interrupted[0]!; store.revokeBindingPrimaryToolCapability(selection.bindingId!, store.getBinding(selection.bindingId!)!.generation); let binding = store.updateBindingMetadata(selection.bindingId!, paneIdentityPatch(pane)); binding = store.transitionBinding(binding.id, { type: "pane_created" }); binding = await this.options.createSelectedProject(selection, project, false); store.completeProjectSelection(selection.id, binding.id); if (selection.selectorMessageId) await this.options.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding); await this.options.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "recovered_provisioning" }); return true; }
    const binding = await this.options.discover(pane, project); await this.options.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "success" }); return true;
  }

  private isRecoverableFailedReset(binding: Binding, message: IncomingLarkMessage, project: ProjectConfig): boolean { return binding.state === "failed" && binding.projectId === project.id && binding.chatId === message.chatId && ((binding.topicId === message.topicId && binding.rootMessageId === message.rootMessageId) || (binding.reservedTopicId === message.topicId && binding.reservedRootMessageId === message.rootMessageId && Boolean(binding.replacesBindingId))); }
  private async recoverFailedResetBinding(binding: Binding, pane: HerdrPane, actorOpenId: string): Promise<Binding> {
    const { store } = this.options; store.revokeBindingPrimaryToolCapability(binding.id, binding.generation);
    if (!binding.replacesBindingId || !binding.reservedTopicId || !binding.reservedRootMessageId) { if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${pane.paneId}`); const identified = store.updateBindingMetadata(binding.id, { ...paneIdentityPatch(pane), statusMessageId: binding.rootMessageId }); const recovered = store.transitionBinding(identified.id, { type: "recover_failed", runtime: pane.agentState }); await this.options.publish(recovered.id, "BindingActivated", "lark", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: recovered.topicId! }); return recovered; }
    const project = binding.projectId ? this.options.projects.projectById(binding.projectId) : undefined; const observation = await this.options.herdr.observeRuntime(pane.paneId);
    if (!project || !observation.pane || !observation.traexProcess || !observation.composerReady || observation.pane.workspaceId !== project.workspaceId || observation.pane.cwd !== project.cwd || !observation.pane.terminalId) throw new Error(`Replacement pane ${pane.paneId} is not ready for reset recovery`);
    const identified = store.updateBindingMetadata(binding.id, paneIdentityPatch(observation.pane)); store.transitionBinding(identified.id, { type: "retry_failed_provisioning", runtime: observation.pane.agentState }); const handoff = store.cutoverResetCandidate({ oldBindingId: binding.replacesBindingId, newBindingId: binding.id, cleanupOperationId: randomUUID(), actorOpenId, expectedCwd: project.cwd }); this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: handoff.previous.id }); this.options.wakeRetiredPaneCleanup?.(); await this.options.publish(handoff.replacement.id, "BindingActivated", "lark", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: handoff.replacement.topicId! }); return handoff.replacement;
  }
}

function paneIdentityPatch(pane: HerdrPane): Pick<Binding, "paneId" | "traexSessionId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"> { return { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null, agentSessionSource: pane.agentSession?.source ?? null, agentSessionAgent: pane.agentSession?.agent ?? null, agentSessionKind: pane.agentSession?.kind ?? null, agentSessionValue: pane.agentSession?.value ?? null }; }
