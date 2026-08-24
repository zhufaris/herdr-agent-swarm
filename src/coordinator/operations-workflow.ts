import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderModelResultCard } from "../cards/model-card.js";
import { renderFailureCards, renderSessionCards } from "../cards/operations-card.js";
import { renderPaneCloseConfirmationCard, renderPaneCloseResultCard } from "../cards/pane-close-card.js";
import { renderMessageRejectedCard, renderProjectEntryCard } from "../cards/run-card.js";
import { renderSpaceDirectoryCards, type SpaceDirectoryGroup } from "../cards/space-directory-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort, LarkPort, OperationsStore, OutboundIntentPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { config: BridgeConfig; store: OperationsStore; herdr: HerdrPort; lark: LarkPort; lifecycleEvents: LifecycleEventPublisher; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler; isBindingBusy(bindingId: string): boolean; logger: Logger; }

export interface OperationsWorkflowPort {
  recover(): Promise<void>;
  openThread(action: IncomingLarkCardAction, bindingId: string): Promise<void>;
  decideDeadLetter(action: IncomingLarkCardAction, replyId: string, decision: "retry_dead_letter" | "dismiss_dead_letter"): Promise<void>;
  listSpaces(message: IncomingLarkMessage): Promise<void>;
  listSessions(message: IncomingLarkMessage): Promise<void>;
  listFailures(message: IncomingLarkMessage): Promise<void>;
  emitStatus(binding: Binding): Promise<void>;
  rename(message: IncomingLarkMessage, binding: Binding | null, title: string): Promise<boolean>;
  archive(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  resume(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean>;
  selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void>;
  requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean>;
}

export class OperationsWorkflow implements OperationsWorkflowPort {
  constructor(private readonly options: Options) {}

  async recover(): Promise<void> {
    const { store, herdr } = this.options;
    for (const operation of store.listUnresolvedPaneCloseOperations()) {
      const binding = store.getBinding(operation.bindingId);
      if (binding?.lifecycle === "closed" && binding.paneId === operation.paneId) { store.finishPaneCloseRequest(operation.id, "succeeded", "binding was already closed before recovery"); continue; }
      if (!binding || binding.paneId !== operation.paneId) { store.finishPaneCloseRequest(operation.id, "uncertain", "binding identity changed before recovery"); continue; }
      try {
        if (await herdr.getPane(operation.paneId)) { store.finishPaneCloseRequest(operation.id, "uncertain", "pane still present after restart; close was not replayed"); continue; }
        let next = store.transitionBinding(binding.id, { type: "archive_requested", hasActiveTurn: false });
        next = store.transitionBinding(next.id, { type: "closed" });
        store.finishPaneCloseRequest(operation.id, "succeeded", "pane absence verified after restart");
        await this.publish(next.id, "BindingArchived", "bridge", { reason: `Herdr pane ${operation.paneId} 的关闭结果已在 Bridge 重启后确认。` });
      } catch (error) { store.finishPaneCloseRequest(operation.id, "uncertain", `restart verification failed: ${errorMessage(error)}`); }
    }
  }

  async openThread(action: IncomingLarkCardAction, bindingId: string): Promise<void> {
    const { store, lark, logger } = this.options; const binding = store.getBinding(bindingId);
    if (!binding || binding.chatId !== action.chatId) return; const target = binding.topicId ?? binding.rootMessageId; if (!target) return;
    try { await lark.shareThread(target, { messageId: action.messageId, chatId: action.chatId }); store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "shared" }); }
    catch (error) { logger.error({ event: "thread-entry-share-failed", err: safeLogError(error), bindingId: binding.id, actionMessageId: action.messageId, outcome: "failed" }, "failed to share project thread entry"); await lark.replyText(action.messageId, "话题入口发送失败，请重新执行 `/herdr spaces` 后重试。"); store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "failed" }); }
  }

  async decideDeadLetter(action: IncomingLarkCardAction, replyId: string, decision: "retry_dead_letter" | "dismiss_dead_letter"): Promise<void> {
    const { store, outbound, logger } = this.options;
    const outcome = decision === "retry_dead_letter" ? store.retryDeadLetter(replyId, action.chatId, action.operatorOpenId) : store.dismissDeadLetter(replyId, action.chatId, action.operatorOpenId);
    logger.info({ event: "dead-letter-action-decided", replyId, action: decision, outcome }, "processed dead-letter action");
    if (outcome === "retried") this.options.outboundWork.wake();
    const notice = outcome === "retried" ? "已重新提交该消息发送；不会重放 TraeX 任务。" : outcome === "dismissed" ? "已忽略该发送失败并保留历史记录。" : "该操作已失效或无权执行。";
    await outbound.enqueueCardUpdate(null, action.messageId, `failures:${action.messageId}:${replyId}:${outcome}`, renderFailureCards(store.listFailures(action.chatId), notice)[0]!);
  }

  async listSpaces(message: IncomingLarkMessage): Promise<void> {
    const { config, herdr, store, logger, outbound } = this.options;
    const panesByWorkspace = new Map<string, HerdrPane[]>(); const errors = new Map<string, string>();
    for (const workspaceId of new Set(config.projects.map((project) => project.workspaceId))) {
      try { panesByWorkspace.set(workspaceId, await herdr.listPanes(workspaceId)); } catch (error) { const safe = safeLogError(error); errors.set(workspaceId, safe.message); logger.warn({ event: "space-directory-workspace-failed", err: safe, workspaceId, outcome: "partial" }, "workspace unavailable while building space directory"); }
    }
    const groups = buildSpaceDirectoryGroups(config.projects, panesByWorkspace, errors); const bindings = store.listBindings();
    for (const group of groups) for (const pane of group.panes) {
      const binding = selectSpaceDirectoryBinding(bindings, pane.paneId, message.chatId); if (binding) pane.bindingId = binding.id;
      if (!bindings.some((candidate) => candidate.paneId === pane.paneId) && !group.unregistered && pane.foregroundExecutables.includes("traex")) {
        const projects = config.projects.filter((project) => project.workspaceId === group.workspaceId && projectSpaceName(project) === group.spaceName && project.cwd === panesByWorkspace.get(group.workspaceId)?.find((candidate) => candidate.paneId === pane.paneId)?.cwd);
        if (projects.length === 1) pane.claimProjectId = projects[0]!.id;
      }
    }
    for (const [index, card] of renderSpaceDirectoryCards(groups).entries()) await outbound.enqueueCard(message.rootMessageId ?? message.messageId, `spaces:${message.messageId}:${index}`, card);
  }

  async listSessions(message: IncomingLarkMessage): Promise<void> { await this.publishCards(message, "sessions", renderSessionCards(this.options.store.listSessions(message.chatId))); }
  async listFailures(message: IncomingLarkMessage): Promise<void> { await this.publishCards(message, "failures", renderFailureCards(this.options.store.listFailures(message.chatId))); }
  async emitStatus(binding: Binding): Promise<void> { await this.publish(binding.id, "AgentStateChanged", "bridge", { state: binding.lastAgentState, queueDepth: this.options.store.countPendingPrompts(binding.id) }); }

  async rename(message: IncomingLarkMessage, binding: Binding | null, title: string): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "这个话题没有可重命名的活动 Pane。请进入活动项目话题，或发送 `/herdr new`。"); return false; }
    const pane = await this.requireMatchingPane(binding, binding.paneId); const project = this.options.config.projects.find((candidate) => candidate.id === binding.projectId);
    const displayTitle = formatProjectPaneTitle(project ? projectSpaceName(project) : null, pane.cwd ?? this.options.config.herdr.workspaceCwd, title, binding.paneId);
    await this.options.herdr.renamePane(binding.paneId, title, { tabTitle: title }); this.options.store.updateBinding(binding.id, { title: displayTitle }); await this.publish(binding.id, "BindingRenamed", "lark", { title: displayTitle }); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "binding.rename", target: binding.id, outcome: "success" }); return true;
  }

  async archive(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding || binding.lifecycle !== "active") { await this.reject(message, "这个话题没有可归档的活动会话。"); return false; }
    const { store } = this.options; const active = this.options.isBindingBusy(binding.id); const reason = active ? "停止接收新消息；当前任务完成后归档。" : "已从飞书归档；Herdr pane 与 TraeX 保持运行。";
    for (const view of store.listRunCards(binding.id).filter((item) => item.phase === "queued")) await this.publish(binding.id, "PromptCancelled", "bridge", { promptId: view.promptId, reason: "话题已归档，排队任务已取消。" });
    store.cancelQueuedPrompts(binding.id, "话题已归档，排队任务已取消。"); const type = active ? "BindingDraining" as const : "BindingArchived" as const;
    const next = await this.transitionAndPublish(binding, { type: "archive_requested", hasActiveTurn: active }, type, reason); store.audit({ actorOpenId: message.actorOpenId, action: "binding.archive", target: binding.id, outcome: next.lifecycle }); return true;
  }

  async resume(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding?.paneId || binding.lifecycle !== "archived") { await this.reject(message, "只有已归档且仍保留 Pane 的会话可以恢复。"); return false; }
    const pane = await this.requireMatchingPane(binding, binding.paneId);
    this.options.store.updateBinding(binding.id, { lastAgentState: pane.agentState });
    const resumed = this.options.store.transitionBinding(binding.id, { type: "activate" });
    await this.publish(resumed.id, "BindingActivated", "lark", { paneId: pane.paneId, topicId: resumed.topicId! }); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "binding.resume", target: binding.id, outcome: "success" }); this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); return true;
  }

  async runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean> {
    const target = name ?? "list"; const { store, herdr, config } = this.options;
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可切换模型的活动 TraeX Pane。"); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "inactive_binding" }); return false; }
    if (this.options.isBindingBusy(binding.id) || store.countPendingPrompts(binding.id) > 0 || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") { await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，请在当前任务或队列完成后重试。"); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "busy" }); return false; }
    if (!herdr.runPaneCommand) { await this.reject(message, "当前 Herdr adapter 不支持模型切换。"); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "unsupported" }); return false; }
    try { const pane = await this.requireMatchingPane(binding, binding.paneId); if (name) { if (!herdr.selectPaneModel) throw new Error("当前 Herdr adapter 不支持交互式模型选择。"); await herdr.selectPaneModel(pane.paneId, name, config.commandTimeoutMs); } const output = await herdr.runPaneCommand(pane.paneId, "/model", config.commandTimeoutMs); await this.reply(message.rootMessageId ?? message.messageId, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: name !== null })); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: name ? "switch_completed" : "list_completed" }); return true; }
    catch (error) { await this.reject(message, `模型命令执行失败：${errorMessage(error)}`); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "failed" }); return false; }
  }

  async selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void> {
    const { store, herdr, config, outbound, logger } = this.options; const binding = store.getBinding(bindingId);
    if (!binding?.paneId || binding.chatId !== action.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    if (this.options.isBindingBusy(binding.id) || store.countPendingPrompts(binding.id) > 0 || binding.lastAgentState === "working" || binding.lastAgentState === "blocked" || !herdr.selectPaneModel || !herdr.runPaneCommand) return;
    try { const pane = await this.requireMatchingPane(binding, binding.paneId); await herdr.selectPaneModel(pane.paneId, model, config.commandTimeoutMs); const output = await herdr.runPaneCommand(pane.paneId, "/model", config.commandTimeoutMs); await outbound.enqueueCardUpdate(binding.id, action.messageId, `model:${binding.id}:${model}`, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: true })); store.audit({ actorOpenId: action.operatorOpenId, action: "model.select", target: model, outcome: "switch_completed" }); }
    catch (error) { logger.warn({ event: "model-selection-failed", err: safeLogError(error), bindingId, paneId: binding.paneId, outcome: "failed" }, "failed to select TraeX model"); store.audit({ actorOpenId: action.operatorOpenId, action: "model.select", target: model, outcome: "failed" }); }
  }

  async requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    const checked = await this.checkPaneCloseSafety(message, binding); if (!checked) return false; const code = randomBytes(3).toString("hex").toUpperCase(); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    this.options.store.createPaneCloseRequest({ id: randomUUID(), bindingId: checked.binding.id, paneId: checked.pane.paneId, actorOpenId: message.actorOpenId, codeHash: paneCloseCodeHash(code), expiresAt });
    await this.reply(message.rootMessageId ?? message.messageId, renderPaneCloseConfirmationCard({ spaceName: this.spaceNameFor(checked.binding), paneId: checked.pane.paneId, agentState: checked.pane.agentState, code, expiresAt })); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.requested", target: checked.binding.id, outcome: "confirmation_issued" }); return true;
  }

  async confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean> {
    const { store, herdr } = this.options; if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可关闭的活动 Pane。"); return false; }
    const outcome = store.consumePaneCloseRequest({ bindingId: binding.id, paneId: binding.paneId, actorOpenId: message.actorOpenId, codeHash: paneCloseCodeHash(code), now: new Date().toISOString() });
    if (outcome.outcome !== "consumed") { const reason = outcome.outcome === "unauthorized" ? "只有发起关闭请求的用户可以确认。" : outcome.outcome === "expired" ? "确认码已过期，请重新发送 `/herdr pane close`。" : outcome.outcome === "stale" ? "没有待确认的关闭请求，请重新发送 `/herdr pane close`。" : "确认码无效。"; await this.reject(message, reason); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: outcome.outcome }); return false; }
    const checked = await this.checkPaneCloseSafety(message, store.getBinding(binding.id), outcome.paneId); if (!checked) { store.finishPaneCloseRequest(outcome.operationId, "rejected", "safety_recheck_failed"); return false; }
    try { await herdr.closePane(checked.pane.paneId); let next = store.transitionBinding(checked.binding.id, { type: "archive_requested", hasActiveTurn: false }); next = store.transitionBinding(next.id, { type: "closed" }); store.finishPaneCloseRequest(outcome.operationId, "succeeded"); await this.publish(next.id, "BindingArchived", "lark", { reason: `Herdr pane ${checked.pane.paneId} 已由飞书确认关闭。` }); await this.reply(message.rootMessageId ?? message.messageId, renderPaneCloseResultCard({ paneId: checked.pane.paneId })); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.completed", target: checked.binding.id, outcome: "closed" }); return true; }
    catch (error) { store.finishPaneCloseRequest(outcome.operationId, "uncertain", errorMessage(error)); await this.reject(message, `Pane 关闭失败或无法验证：${errorMessage(error)}`); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.failed", target: checked.binding.id, outcome: "unverified" }); return false; }
  }

  private async checkPaneCloseSafety(message: IncomingLarkMessage, binding: Binding | null, expectedPaneId?: string): Promise<{ binding: Binding; pane: HerdrPane } | null> {
    const { store, herdr } = this.options; if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可关闭的活动 Pane。"); return null; }
    if (expectedPaneId !== undefined && binding.paneId !== expectedPaneId) { await this.reject(message, "Pane identity 已变化，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" }); return null; }
    if (this.options.isBindingBusy(binding.id) || store.countPendingPrompts(binding.id) > 0) { await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "busy" }); return null; }
    const pane = await herdr.getPane(binding.paneId); if (!pane) { const orphaned = store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 1 }); await this.publish(orphaned.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` }); await this.reject(message, `Pane ${binding.paneId} 已不存在，绑定已标记为 orphaned。`); return null; }
    if (pane.workspaceId !== binding.workspaceId || binding.traexSessionId === null || pane.terminalId !== binding.traexSessionId) { await this.reject(message, "Pane identity 已变化，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" }); return null; }
    if (pane.agentState !== "idle" && pane.agentState !== "done") { await this.reject(message, `Pane 当前状态为 ${pane.agentState}，不能关闭；仅 idle/done 状态允许关闭。`); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: pane.agentState }); return null; } return { binding, pane };
  }

  private async requireMatchingPane(binding: Binding, paneId: string): Promise<HerdrPane> { const pane = (await this.options.herdr.observeRuntime(paneId)).pane; if (!pane) throw new Error(`Herdr pane ${paneId} not found`); if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`); const project = this.options.config.projects.find((item) => item.id === binding.projectId); if (project && pane.cwd !== project.cwd) throw new Error(`Herdr pane ${paneId} does not match project ${project.displayName}`); if (binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${paneId}`); if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${paneId}`); return pane; }
  private async transitionAndPublish(binding: Binding, transition: import("../domain/pane-thread-lifecycle.js").SessionTransition, type: "BindingDraining" | "BindingArchived", reason: string): Promise<Binding> { const event = createBridgeEvent(binding.id, type, "lark", { reason }); const current = this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id); const view = reduceTopicView(current, event); if (!binding.statusMessageId) { const next = this.options.store.transitionBinding(binding.id, transition); await this.options.lifecycleEvents.publish(event); return next; } const next = this.options.store.transitionBindingWithOutbox({ id: binding.id, transition, event, view, messageId: binding.statusMessageId, card: renderProjectEntryCard(view) }); this.options.outboundWork.wake(); await this.options.lifecycleEvents.publish(event); return next; }
  private async publishCards(message: IncomingLarkMessage, kind: string, cards: object[]): Promise<void> { for (const [index, card] of cards.entries()) await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `${kind}:${message.messageId}:${index}`, card); this.options.logger.info({ event: `operation-${kind}-listed`, chatId: message.chatId, pageCount: cards.length, outcome: "listed" }, `listed Herdr ${kind}`); }
  private spaceNameFor(binding: Binding): string { const matches = binding.projectId ? this.options.config.projects.filter((project) => project.id === binding.projectId) : this.options.config.projects.filter((project) => project.workspaceId === binding.workspaceId); return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved"; }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
  private async publish(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload) as ReturnType<typeof createBridgeEvent>); }
}

export function buildSpaceDirectoryGroups(projects: readonly ProjectConfig[], panesByWorkspace: ReadonlyMap<string, HerdrPane[]>, errors: ReadonlyMap<string, string>): SpaceDirectoryGroup[] {
  const groups = new Map<string, SpaceDirectoryGroup>(); for (const project of projects) { const spaceName = projectSpaceName(project); const key = `${project.workspaceId}\0${spaceName}`; const group = groups.get(key) ?? { spaceName, workspaceId: project.workspaceId, directories: [], panes: [] }; if (!group.directories.includes(project.cwd)) group.directories.push(project.cwd); const error = errors.get(project.workspaceId); if (error) group.error = error; groups.set(key, group); }
  const result = [...groups.values()]; for (const [workspaceId, panes] of panesByWorkspace) { const workspaceGroups = result.filter((group) => group.workspaceId === workspaceId); const unmatched = []; for (const pane of panes) { const group = workspaceGroups.find((candidate) => pane.cwd !== null && candidate.directories.includes(pane.cwd)); const view = { paneId: pane.paneId, name: pane.label ?? pane.paneId, agentState: pane.agentState, foregroundExecutables: pane.foregroundExecutables }; if (group) group.panes.push(view); else unmatched.push(view); } if (unmatched.length) result.push({ spaceName: "未注册", workspaceId, directories: [], panes: unmatched, unregistered: true }); } return result;
}
type SpaceDirectoryBindingCandidate = Pick<Binding, "id" | "paneId" | "chatId" | "topicId" | "rootMessageId" | "lifecycle" | "updatedAt">;
export function selectSpaceDirectoryBinding(bindings: readonly SpaceDirectoryBindingCandidate[], paneId: string, chatId: string): SpaceDirectoryBindingCandidate | null { const rank: Partial<Record<Binding["lifecycle"], number>> = { active: 0, draining: 1, archived: 2 }; return bindings.filter((binding) => binding.paneId === paneId && binding.chatId === chatId && Boolean(binding.topicId ?? binding.rootMessageId) && rank[binding.lifecycle] !== undefined).sort((left, right) => rank[left.lifecycle]! - rank[right.lifecycle]! || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0] ?? null; }
function paneCloseCodeHash(code: string): string { return createHash("sha256").update(code.trim().toUpperCase()).digest("hex"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
