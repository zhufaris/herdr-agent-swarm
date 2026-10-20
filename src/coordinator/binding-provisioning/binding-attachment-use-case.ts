import { randomUUID } from "node:crypto";
import { projectSpaceName, type BridgeConfig } from "../../config.js";
import type { BindingProvisioningStore, RuntimeIdentityTransitionApplication, RuntimeIdentityTransitionFence } from "../../domain/ports/binding.js";
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
    discover(pane: HerdrPane, project: ProjectConfig, activate?: boolean): Promise<Binding>;
    publishSelectionSuccess(selectionId: string, selectorMessageId: string, project: ProjectConfig, binding: Binding): Promise<void>;
    publish(bindingId: string, type: "BindingActivated" | "BindingArchived" | "PrimaryToolAvailabilityChanged", origin: "lark" | "bridge", payload: Record<string, unknown>): Promise<void>;
    publishAttachSuccess(message: IncomingLarkMessage, binding: Binding, spaceName: string, alreadyAttached: boolean, resumeRequired?: boolean, toolsUnavailable?: boolean): Promise<void>;
    reject(message: IncomingLarkMessage, reason: string): Promise<void>;
  }) {}

  async attach(message: IncomingLarkMessage, requestedSpaceName: string | null, paneReference: string): Promise<boolean> {
    const { config, store, herdr } = this.options;
    let project: ProjectConfig;
    let panes: HerdrPane[];
    let paneByToken: HerdrPane | undefined;
    let spaceName: string;
    if (requestedSpaceName === null) {
      if (!/^[a-z0-9]{4}$/i.test(paneReference)) { await this.options.reject(message, "请提供四位 Pane Token，例如 `/swarm attach cum7`。"); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "invalid_pane_token" }); return false; }
      const workspaceIds = [...new Set(this.options.projects.projects.map((candidate) => candidate.workspaceId))];
      const discovered = (await Promise.all(workspaceIds.map((workspaceId) => herdr.listPanes(workspaceId, { forceRefresh: true })))).flat()
        .filter((candidate, index, all) => all.findIndex((other) => other.paneId === candidate.paneId) === index);
      const tokenMatches = discovered.filter((candidate) => paneToken(candidate) === paneReference.toLowerCase());
      if (tokenMatches.length !== 1) { await this.options.reject(message, tokenMatches.length === 0 ? `未找到 Pane Token ${paneReference.toLowerCase()}。` : `Pane Token ${paneReference.toLowerCase()} 不唯一，请改用旧语法并指定 Space 与 Pane ID：${tokenMatches.map((candidate) => candidate.paneId).sort().join(", ")}`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: tokenMatches.length === 0 ? "pane_not_found" : "ambiguous_pane_token" }); return false; }
      paneByToken = tokenMatches[0]!;
      const workspaceProjects = this.options.projects.projects.filter((candidate) => candidate.workspaceId === paneByToken!.workspaceId);
      const cwdProjects = workspaceProjects.filter((candidate) => candidate.cwd === paneByToken!.cwd);
      const projectMatches = cwdProjects.length > 0 ? cwdProjects : workspaceProjects;
      if (projectMatches.length !== 1) { await this.options.reject(message, `Pane Token ${paneReference.toLowerCase()} 无法唯一确定项目，请改用旧语法并指定 Space。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_project" }); return false; }
      project = projectMatches[0]!; panes = discovered.filter((candidate) => candidate.workspaceId === project.workspaceId); spaceName = projectSpaceName(project);
    } else {
      const projects = this.options.projects.projectsForExplicitSpaceName(requestedSpaceName);
      if (projects.length !== 1) { await this.options.reject(message, projects.length === 0 ? `未找到空间 ${requestedSpaceName}。` : `空间 ${requestedSpaceName} 对应多个项目，无法确定要连接哪一个。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: projects.length === 0 ? "unknown_space" : "ambiguous_space" }); return false; }
      project = projects[0]!; panes = (await herdr.listPanes(project.workspaceId, { forceRefresh: true })).filter((candidate) => candidate.workspaceId === project.workspaceId); spaceName = requestedSpaceName;
    }
    const exactId = paneByToken ?? panes.find((candidate) => candidate.paneId === paneReference); const labelMatches = exactId ? [] : panes.filter((candidate) => candidate.label === paneReference);
    if (!exactId && labelMatches.length > 1) { await this.options.reject(message, `Pane 名称 ${paneReference} 不唯一，请改用 Pane ID：${labelMatches.map((candidate) => candidate.paneId).sort().join(", ")}`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_label" }); return false; }
    const tokenMatches = exactId || labelMatches.length > 0 || !/^[a-z0-9]{4}$/i.test(paneReference) ? [] : panes.filter((candidate) => paneToken(candidate) === paneReference.toLowerCase());
    if (tokenMatches.length > 1) { await this.options.reject(message, `Pane token ${paneReference} 不唯一，请改用 Pane ID：${tokenMatches.map((candidate) => candidate.paneId).sort().join(", ")}`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "ambiguous_pane_token" }); return false; }
    const pane = exactId ?? labelMatches[0] ?? tokenMatches[0];
    if (!pane) { await this.options.reject(message, `在空间 ${spaceName} 的 Herdr workspace ${project.workspaceId} 中未找到 Pane ${paneReference}。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: paneReference, outcome: "pane_not_found" }); return false; }
    const existing = store.findBindingByPane(pane.paneId);
    if (existing) {
      if (existing.kind === "orchestrator") { const attached = this.adoptReviewOwner(existing, message.actorOpenId); if (store.hasBindingPrimaryToolCapability(attached.id, attached.generation)) await this.options.publish(attached.id, "PrimaryToolAvailabilityChanged", "bridge", { available: true, reason: null }); await this.options.publishAttachSuccess(message, attached, spaceName, true, false, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: attached.id, outcome: "orchestrator_fixed" }); return true; }
      if (this.isRecoverableFailedReset(existing, message, project)) { const recovered = this.adoptReviewOwner(await this.recoverFailedResetBinding(existing, pane, message.actorOpenId), message.actorOpenId); await this.options.publishAttachSuccess(message, recovered, spaceName, false, false, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.attachment === "orphaned" && existing.topicId && existing.rootMessageId) { const observedPane = await requireMatchingPane(herdr, this.options.projects, existing, pane.paneId); const recovered = this.adoptReviewOwner(requireBindingUpdate(store.applyRuntimeIdentityTransition({ kind: "attach_binding_pane", expected: runtimeIdentityFence(existing), pane: observedPane, replacement: false })), message.actorOpenId); await this.options.publish(recovered.id, "BindingArchived", "lark", { reason: "Pane 已验证并恢复连接；为避免重放不确定任务，请进入原话题发送 `/swarm resume` 后再继续队列。" }); await this.options.publishAttachSuccess(message, recovered, spaceName, true, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_orphaned" }); return true; }
      if (existing.chatId === config.lark.chatId && existing.projectId === project.id && existing.state === "active") {
        const candidate = await this.options.discover(pane, project, false);
        const handoff = requireAttachedThreadCutover(store.applyRuntimeIdentityTransition({ kind: "cutover_attached_pane_thread", actorOpenId: message.actorOpenId, expectedPrevious: runtimeIdentityFence(existing), expectedReplacement: runtimeIdentityFence(candidate) }));
        const attached = this.adoptReviewOwner(handoff.replacement, message.actorOpenId);
        await this.options.publish(handoff.previous.id, "BindingArchived", "lark", { reason: "Pane 已连接到新的飞书话题；旧话题已归档，Pane 与 Agent 保持运行。" });
        await this.options.publish(attached.id, "BindingActivated", "lark", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: attached.topicId! });
        this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: existing.id }); this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: attached.id });
        await this.options.publishAttachSuccess(message, attached, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: attached.id, outcome: "thread_rotated" }); return true;
      }
      await this.options.reject(message, `Pane ${pane.paneId} 已绑定到其他会话，不能在这里重新连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: existing.id, outcome: "bound_elsewhere" }); return false;
    }
    if (!agentKindFromHerdr(pane.agentKind) && !pane.foregroundExecutables.includes("traex")) { await this.options.reject(message, `Pane ${pane.paneId} 当前没有可识别的受支持 Agent，未执行连接。`); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: pane.paneId, outcome: "agent_not_running" }); return false; }
    const topicBinding = store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (topicBinding && this.isRecoverableFailedReset(topicBinding, message, project)) { const recovered = this.adoptReviewOwner(await this.recoverFailedResetBinding(topicBinding, pane, message.actorOpenId), message.actorOpenId); await this.options.publishAttachSuccess(message, recovered, spaceName, false, false, true); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: recovered.id, outcome: "recovered_reset" }); return true; }
    const interrupted = store.listProcessingProjectSelections().filter((selection) => selection.bindingId && selection.selectedProjectId === project.id && store.getBinding(selection.bindingId)?.provisioningCheckpoint === "selected");
    if (interrupted.length === 1) { const selection = interrupted[0]!; const interruptedBinding = store.getBinding(selection.bindingId!)!; store.revokeBindingPrimaryToolCapability(selection.bindingId!, interruptedBinding.generation); let binding = transitionBindingPane(store, interruptedBinding, pane, { type: "pane_created" }); binding = await this.options.createSelectedProject(selection, project, false); store.completeProjectSelection(selection.id, binding.id); binding = this.adoptReviewOwner(binding, message.actorOpenId); if (selection.selectorMessageId) await this.options.publishSelectionSuccess(selection.id, selection.selectorMessageId, project, binding); await this.options.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "recovered_provisioning" }); return true; }
    const binding = this.adoptReviewOwner(await this.options.discover(pane, project), message.actorOpenId); await this.options.publishAttachSuccess(message, binding, spaceName, false); store.audit({ actorOpenId: message.actorOpenId, action: "binding.attach", target: binding.id, outcome: "success" }); return true;
  }

  private adoptReviewOwner(binding: Binding, actorOpenId: string): Binding {
    if (binding.creatorOpenId || !binding.paneId) return binding;
    return this.options.store.adoptBindingReviewOwnerIfEmpty({ bindingId: binding.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId, actorOpenId }) ?? binding;
  }

  private isRecoverableFailedReset(binding: Binding, message: IncomingLarkMessage, project: ProjectConfig): boolean { return binding.state === "failed" && binding.projectId === project.id && binding.chatId === message.chatId && ((binding.topicId === message.topicId && binding.rootMessageId === message.rootMessageId) || (binding.reservedTopicId === message.topicId && binding.reservedRootMessageId === message.rootMessageId && Boolean(binding.replacesBindingId))); }
  private async recoverFailedResetBinding(binding: Binding, pane: HerdrPane, actorOpenId: string): Promise<Binding> {
    const { store } = this.options; store.revokeBindingPrimaryToolCapability(binding.id, binding.generation);
    if (!binding.replacesBindingId || !binding.reservedTopicId || !binding.reservedRootMessageId) { if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${pane.paneId}`); const recovered = transitionBindingPane(store, binding, pane, { type: "recover_failed", runtime: pane.agentState }); const identified = store.updateBindingMetadata(recovered.id, { statusMessageId: recovered.rootMessageId }); await this.options.publish(identified.id, "BindingActivated", "lark", { paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: identified.topicId! }); return identified; }
    const project = binding.projectId ? this.options.projects.projectById(binding.projectId) : undefined; const observation = await this.options.herdr.observeRuntime(pane.paneId);
    if (!project || !observation.pane || !observation.traexProcess || !observation.composerReady || observation.pane.workspaceId !== project.workspaceId || observation.pane.cwd !== project.cwd || !observation.pane.terminalId) throw new Error(`Replacement pane ${pane.paneId} is not ready for reset recovery`);
    const identified = transitionBindingPane(store, binding, observation.pane, { type: "retry_failed_provisioning", runtime: observation.pane.agentState }); const previous = store.getBinding(binding.replacesBindingId); if (!previous) throw new Error(`Replacement source Binding ${binding.replacesBindingId} is missing`); const handoff = requireResetCutover(store.applyRuntimeIdentityTransition({ kind: "cutover_reset_candidate", cleanupOperationId: randomUUID(), actorOpenId, expectedCwd: project.cwd, expectedPrevious: runtimeIdentityFence(previous), expectedReplacement: runtimeIdentityFence(identified) })); this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: handoff.previous.id }); this.options.wakeRetiredPaneCleanup?.(); await this.options.publish(handoff.replacement.id, "BindingActivated", "lark", { paneId: pane.paneId, paneToken: observation.pane.paneToken ?? null, paneName: observation.pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: handoff.replacement.topicId! }); return handoff.replacement;
  }
}

function transitionBindingPane(store: BindingProvisioningStore, binding: Binding, pane: HerdrPane, transition: Parameters<BindingProvisioningStore["transitionBinding"]>[1]): Binding {
  return requireBindingUpdate(store.applyRuntimeIdentityTransition({ kind: "observe_binding_pane", expected: runtimeIdentityFence(binding), pane, transition }));
}
function requireBindingUpdate(result: RuntimeIdentityTransitionApplication): Binding { if (result.outcome !== "binding_updated") throw new Error(`Expected Binding identity update, received ${result.outcome}`); return result.binding; }
function requireResetCutover(result: RuntimeIdentityTransitionApplication) { if (result.outcome !== "reset_cutover") throw new Error(`Expected reset identity cutover, received ${result.outcome}`); return result; }
function requireAttachedThreadCutover(result: RuntimeIdentityTransitionApplication) { if (result.outcome !== "attached_thread_cutover") throw new Error(`Expected attached-thread identity cutover, received ${result.outcome}`); return result; }
function runtimeIdentityFence(binding: Binding): RuntimeIdentityTransitionFence {
  return {
    owner: { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch },
    workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId, attachment: binding.attachment,
    nativeIdentity: binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
      : null
  };
}
function paneToken(pane: HerdrPane): string | null { return pane.paneToken?.toLowerCase() ?? canonicalPrimaryPaneToken(pane.label); }
