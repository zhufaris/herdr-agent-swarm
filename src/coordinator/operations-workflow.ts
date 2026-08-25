import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderModelModeCard, renderModelResultCard } from "../cards/model-card.js";
import { renderFailureCards, renderSessionCards } from "../cards/operations-card.js";
import { renderPaneCloseConfirmationCard, renderPaneCloseResultCard } from "../cards/pane-close-card.js";
import { renderMessageRejectedCard, renderProjectEntryCard } from "../cards/run-card.js";
import { renderSpaceDirectoryCards, type SpaceDirectoryGroup } from "../cards/space-directory-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort, LarkPort, OperationsStore, OutboundIntentPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { Binding, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, PaneControlOperation, ProjectConfig } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { config: BridgeConfig; store: OperationsStore; herdr: HerdrPort; lark: LarkPort; lifecycleEvents: LifecycleEventPublisher; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler; isBindingBusy(bindingId: string): boolean; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; logger: Logger; }

const MODEL_MODE_SELECTION_TTL_MS = 5 * 60_000;

export interface OperationsWorkflowPort {
  recover(): Promise<void>;
  shutdown(): void;
  drainPaneControls(bindingId: string): Promise<void>;
  openThread(action: IncomingLarkCardAction, bindingId: string): Promise<void>;
  decideDeadLetter(action: IncomingLarkCardAction, replyId: string, decision: "retry_dead_letter" | "dismiss_dead_letter"): Promise<void>;
  listSpaces(message: IncomingLarkMessage): Promise<void>;
  listSessions(message: IncomingLarkMessage): Promise<void>;
  listFailures(message: IncomingLarkMessage): Promise<void>;
  emitStatus(binding: Binding): Promise<void>;
  rename(message: IncomingLarkMessage, binding: Binding | null, title: string): Promise<boolean>;
  archive(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  resume(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  stop(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  steer(message: IncomingLarkMessage, binding: Binding | null, text: string): Promise<boolean>;
  runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean>;
  selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void>;
  selectModelMode(action: IncomingLarkCardAction, bindingId: string, operationId: string, mode: string): Promise<void>;
  requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>;
  confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean>;
}

export class OperationsWorkflow implements OperationsWorkflowPort {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly modelModeExpiryTimers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly options: Options) {}

  shutdown(): void {
    for (const timer of this.modelModeExpiryTimers.values()) clearTimeout(timer);
    this.modelModeExpiryTimers.clear();
  }

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
    for (const operation of store.listRecoverablePaneControlOperations()) {
      const pending = operation.kind === "model" ? pendingModelMode(operation.detail) : null;
      if (pending && Date.parse(pending.expiresAt) > Date.now()) { this.scheduleModelModeExpiry(operation, pending); continue; }
      if (pending) {
        this.clearModelModeExpiry(operation.id);
        store.finishPaneControlOperation(operation.id, "rejected", expiredModelModeDetail(pending));
        const binding = store.getBinding(operation.bindingId);
        if (binding) await this.updateModelModeFailure(binding, operation, "模型模式选择已过期，请重新发送 `/model`。", "expired");
        continue;
      }
      store.finishPaneControlOperation(operation.id, "uncertain", "Bridge restarted after pane input may have been sent; operation was not replayed");
    }
    for (const binding of store.listBindings()) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
  }

  async drainPaneControls(bindingId: string): Promise<void> {
    const previous = this.workers.get(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainPaneControlsOnce(bindingId)).finally(() => { if (this.workers.get(bindingId) === worker) this.workers.delete(bindingId); });
    this.workers.set(bindingId, worker);
    await worker;
  }

  async stop(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可停止的活动任务。`/stop` 未进入任务队列。"); return false; }
    const active = this.options.activeTurn(binding.id);
    if (!active || active.paneId !== binding.paneId || !this.options.herdr.sendEscape) { await this.reject(message, "当前没有可停止的活动 TraeX 任务。`/stop` 未进入任务队列。"); return false; }
    const accepted = this.acceptControl({ message, binding, kind: "stop", parentPromptId: active.promptId });
    if (accepted.inserted) {
      const claimed = this.options.store.claimPaneControlOperation(accepted.operation.id);
      if (claimed) await this.executeStop(claimed, binding);
      else this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
    }
    return true;
  }

  async steer(message: IncomingLarkMessage, binding: Binding | null, text: string): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可 steering 的活动任务。"); return false; }
    const active = this.options.activeTurn(binding.id);
    if (!active || active.paneId !== binding.paneId || !this.options.herdr.steerPrompt) { await this.reject(message, "当前没有可 steering 的活动 TraeX 任务。`/steer` 未进入任务队列。"); return false; }
    const accepted = this.acceptControl({ message, binding, kind: "steer", payload: text, parentPromptId: active.promptId });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
    return true;
  }

  private async drainPaneControlsOnce(bindingId: string): Promise<void> {
    for (let operation = this.options.store.claimNextPaneControlOperation(bindingId); operation; operation = this.options.store.claimNextPaneControlOperation(bindingId)) {
      const binding = this.options.store.getBinding(operation.bindingId);
      if (!binding || binding.paneId !== operation.paneId || binding.generation !== operation.bindingGeneration) {
        this.options.store.finishPaneControlOperation(operation.id, "rejected", "Pane identity changed before control dispatch");
        continue;
      }
      if (operation.kind === "stop") {
        await this.executeStop(operation, binding);
        continue;
      }
      if (operation.kind === "steer") {
        await this.executeSteer(operation, binding);
        continue;
      }
      await this.executeModel(operation, binding);
    }
  }

  private async executeStop(operation: PaneControlOperation, binding: Binding): Promise<void> {
    if (!this.options.activeTurn(binding.id) || !this.options.herdr.sendEscape) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "No supervised active turn remains for Esc"); return; }
    try {
      await this.options.herdr.sendEscape(operation.paneId);
      this.options.store.finishPaneControlOperation(operation.id, "applied", "Esc sent; awaiting runtime observation");
      this.options.store.audit({ actorOpenId: operation.actorOpenId, action: "prompt.stop", target: binding.id, outcome: "esc_sent" });
    } catch (error) {
      this.options.store.finishPaneControlOperation(operation.id, "uncertain", `Esc result cannot be confirmed: ${errorMessage(error)}`);
    }
  }

  private async executeSteer(operation: PaneControlOperation, binding: Binding): Promise<void> {
    const active = this.options.activeTurn(binding.id);
    if (!active || active.promptId !== operation.parentPromptId || active.paneId !== operation.paneId || !this.options.herdr.steerPrompt || !operation.payload) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "TraeX is no longer steerable; text was not injected"); return; }
    try {
      const tail = await this.options.herdr.readOutput(operation.paneId, 80);
      if (isApprovalPrompt(tail)) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "TraeX approval remains local to Herdr; steering text was not injected"); return; }
      const result = await this.options.herdr.steerPrompt(operation.paneId, operation.payload);
      this.options.store.finishPaneControlOperation(operation.id, result === "injected" ? "confirmed" : "rejected", result === "injected" ? "Steering injected into active turn" : "TraeX is no longer steerable; text was not injected");
      this.options.store.audit({ actorOpenId: operation.actorOpenId, action: "prompt.steer", target: binding.id, outcome: result });
    } catch (error) { this.options.store.finishPaneControlOperation(operation.id, "uncertain", `Steering result cannot be confirmed: ${errorMessage(error)}`); }
  }

  private async executeModel(operation: PaneControlOperation, binding: Binding): Promise<void> {
    if (this.options.activeTurn(binding.id) || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") {
      this.options.store.finishPaneControlOperation(operation.id, "rejected", "Pane was not idle when model control was claimed");
      return;
    }
    await this.runAcceptedModel(operation, binding.rootMessageId ?? operation.sourceMessageId, operation.payload);
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
    if (!herdr.runPaneCommand) { await this.reject(message, "当前 Herdr adapter 不支持模型切换。"); store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "unsupported" }); return false; }
    const accepted = this.acceptControl({ message, binding, kind: "model", ...(name === null ? {} : { payload: name }) });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
    return true;
  }

  async selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void> {
    const { store, herdr, config, outbound, logger } = this.options; const binding = store.getBinding(bindingId);
    if (!binding?.paneId || binding.chatId !== action.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    if (!herdr.beginPaneModelSelection || !herdr.runPaneCommand) {
      await outbound.enqueueCardUpdate(binding.id, action.messageId, `model:${binding.id}:${model}:unsupported`, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId, output: "当前 Herdr adapter 不支持模型切换。", switched: false }));
      return;
    }
    const accepted = store.acceptPaneControlOperation({
      id: randomUUID(), idempotencyKey: `card:${action.messageId}:${binding.id}:model:${model}`, bindingId: binding.id, paneId: binding.paneId, terminalId: binding.traexSessionId, bindingGeneration: binding.generation,
      kind: "model", payload: model, actorOpenId: action.operatorOpenId, sourceMessageId: action.messageId
    });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
  }

  async selectModelMode(action: IncomingLarkCardAction, bindingId: string, operationId: string, mode: string): Promise<void> {
    const { store, herdr, config, outbound } = this.options;
    const binding = store.getBinding(bindingId);
    const operation = store.getPaneControlOperation(operationId);
    if (!binding?.paneId || binding.chatId !== action.chatId || !operation || operation.bindingId !== binding.id || operation.kind !== "model" || operation.state !== "applied") return;
    const pending = pendingModelMode(operation.detail);
    if (!pending || !pending.modes.includes(mode) || !herdr.completePaneModelMode) {
      await this.updateModelModeFailure(binding, operation, "模型模式选择已失效，请重新发送 `/model`。", "stale");
      return;
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      const claimed = store.claimAppliedPaneControlOperation(operation.id);
      if (!claimed) return;
      this.clearModelModeExpiry(claimed.id);
      store.finishPaneControlOperation(claimed.id, "rejected", expiredModelModeDetail(pending));
      await this.updateModelModeFailure(binding, claimed, "模型模式选择已过期，请重新发送 `/model`。", "expired");
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return;
    }
    if (!modelOperationMatchesBinding(operation, binding)) {
      const claimed = store.claimAppliedPaneControlOperation(operation.id);
      if (!claimed) return;
      this.clearModelModeExpiry(claimed.id);
      store.finishPaneControlOperation(claimed.id, "rejected", "Binding identity changed before model mode selection");
      await this.updateModelModeFailure(binding, claimed, "Pane identity 已变化，请重新发送 `/model`。", "stale-identity");
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return;
    }
    const claimed = store.claimAppliedPaneControlOperation(operation.id);
    if (!claimed) return;
    this.clearModelModeExpiry(claimed.id);
    try {
      let currentBinding = store.getBinding(binding.id);
      if (!currentBinding || !modelOperationMatchesBinding(claimed, currentBinding)) throw new StaleModelModeError();
      const pane = await this.requireMatchingPane(currentBinding, claimed.paneId);
      currentBinding = store.getBinding(binding.id);
      if (!currentBinding || !modelOperationMatchesBinding(claimed, currentBinding)) throw new StaleModelModeError();
      if (Date.parse(pending.expiresAt) <= Date.now()) throw new ExpiredModelModeError();
      await herdr.completePaneModelMode(pane.paneId, mode, config.commandTimeoutMs);
      const output = await herdr.runPaneCommand!(pane.paneId, "/model", config.commandTimeoutMs);
      store.finishPaneControlOperation(claimed.id, "confirmed", "Model selection confirmed: " + pending.model + " / " + mode);
      await outbound.enqueueCardUpdate(binding.id, claimed.sourceMessageId, "model:" + claimed.id + ":confirmed", renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: true }));
      store.audit({ actorOpenId: action.operatorOpenId, action: "model.mode", target: pending.model + "/" + mode, outcome: "switch_completed" });
    } catch (error) {
      const stale = error instanceof StaleModelModeError;
      const expired = error instanceof ExpiredModelModeError;
      store.finishPaneControlOperation(claimed.id, stale || expired ? "rejected" : "uncertain", stale ? "Binding identity changed before model mode input" : expired ? expiredModelModeDetail(pending) : "Model mode may have applied: " + errorMessage(error));
      await this.updateModelModeFailure(binding, claimed, stale ? "Pane identity 已变化，请重新发送 `/model`。" : expired ? "模型模式选择已过期，请重新发送 `/model`。" : "模型模式选择无法确认：" + errorMessage(error), stale ? "stale-identity" : expired ? "expired" : "uncertain");
    } finally { this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); }
  }

  private async runAcceptedModel(operation: PaneControlOperation, rootMessageId: string, name: string | null): Promise<boolean> {
    const { store, herdr, config } = this.options;
    const binding = store.getBinding(operation.bindingId);
    if (!binding || binding.paneId !== operation.paneId || binding.generation !== operation.bindingGeneration || this.options.activeTurn(binding.id) || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") {
      store.finishPaneControlOperation(operation.id, "rejected", "Pane is no longer idle or identity changed before model control");
      return false;
    }
    try {
      const pane = await this.requireMatchingPane(binding, operation.paneId);
      if (name) {
        if (!herdr.beginPaneModelSelection) throw new Error("当前 Herdr adapter 不支持交互式模型选择。");
        const selection = await herdr.beginPaneModelSelection(pane.paneId, name, config.commandTimeoutMs);
        if (selection.kind === "mode_required") {
          const expiresAt = new Date(Date.now() + MODEL_MODE_SELECTION_TTL_MS).toISOString();
          store.finishPaneControlOperation(operation.id, "applied", JSON.stringify({ phase: "waiting_for_mode", model: name, modes: selection.modes, expiresAt }));
          this.scheduleModelModeExpiry(operation, { model: name, modes: selection.modes, expiresAt });
          const card = renderModelModeCard({ bindingId: binding.id, operationId: operation.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, model: name, modes: selection.modes });
          if (operation.idempotencyKey.startsWith("card:")) await this.options.outbound.enqueueCardUpdate(binding.id, operation.sourceMessageId, "model:" + operation.id + ":mode-required", card);
          else await this.reply(rootMessageId, card);
          store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name, outcome: "mode_required" });
          return true;
        }
      }
      const output = await herdr.runPaneCommand!(pane.paneId, "/model", config.commandTimeoutMs);
      store.finishPaneControlOperation(operation.id, "confirmed", name ? "Model selection confirmed" : "Model selector listed");
      const card = renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: name !== null });
      if (operation.idempotencyKey.startsWith("card:")) await this.options.outbound.enqueueCardUpdate(binding.id, operation.sourceMessageId, `model:${operation.id}:confirmed`, card);
      else await this.reply(rootMessageId, card);
      store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name ?? "list", outcome: name ? "switch_completed" : "list_completed" });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return true;
    } catch (error) {
      store.finishPaneControlOperation(operation.id, "uncertain", `Model operation may have applied: ${errorMessage(error)}`);
      const failure = `模型命令执行失败或无法确认：${errorMessage(error)}`;
      if (operation.idempotencyKey.startsWith("card:")) await this.options.outbound.enqueueCardUpdate(binding.id, operation.sourceMessageId, `model:${operation.id}:uncertain`, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: operation.paneId, output: failure, switched: false }));
      else await this.reject({ eventId: operation.id, messageId: operation.sourceMessageId, chatId: binding.chatId, topicId: binding.topicId, rootMessageId, actorOpenId: operation.actorOpenId, text: "/model", mentionsBot: false, isRootMessage: false }, failure);
      store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name ?? "list", outcome: "uncertain" });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return false;
    }
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

  private acceptControl(input: { message: IncomingLarkMessage; binding: Binding; kind: PaneControlOperation["kind"]; payload?: string; parentPromptId?: string }): { operation: PaneControlOperation; inserted: boolean } {
    const terminalId = input.binding.traexSessionId;
    return this.options.store.acceptPaneControlOperation({
      id: randomUUID(), idempotencyKey: `message:${input.message.messageId}:${input.kind}`, bindingId: input.binding.id, paneId: input.binding.paneId!, terminalId,
      bindingGeneration: input.binding.generation, kind: input.kind, payload: input.payload ?? null, parentPromptId: input.parentPromptId ?? null,
      actorOpenId: input.message.actorOpenId, sourceMessageId: input.message.messageId
    });
  }

  private async checkPaneCloseSafety(message: IncomingLarkMessage, binding: Binding | null, expectedPaneId?: string): Promise<{ binding: Binding; pane: HerdrPane } | null> {
    const { store, herdr } = this.options; if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可关闭的活动 Pane。"); return null; }
    if (expectedPaneId !== undefined && binding.paneId !== expectedPaneId) { await this.reject(message, "Pane identity 已变化，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" }); return null; }
    if (this.options.isBindingBusy(binding.id) || store.countPendingPrompts(binding.id) > 0) { await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "busy" }); return null; }
    const pane = await herdr.getPane(binding.paneId); if (!pane) { const orphaned = store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 1 }); await this.publish(orphaned.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` }); await this.reject(message, `Pane ${binding.paneId} 已不存在，绑定已标记为 orphaned。`); return null; }
    if (pane.workspaceId !== binding.workspaceId || binding.traexSessionId === null || pane.terminalId !== binding.traexSessionId) { await this.reject(message, "Pane identity 已变化，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" }); return null; }
    if (pane.agentState !== "idle" && pane.agentState !== "done") { await this.reject(message, `Pane 当前状态为 ${pane.agentState}，不能关闭；仅 idle/done 状态允许关闭。`); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: pane.agentState }); return null; } return { binding, pane };
  }

  private async updateModelModeFailure(binding: Binding, operation: PaneControlOperation, output: string, suffix: string): Promise<void> {
    await this.options.outbound.enqueueCardUpdate(binding.id, operation.sourceMessageId, `model:${operation.id}:${suffix}`, renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: operation.paneId, output, switched: false }));
  }

  private scheduleModelModeExpiry(operation: PaneControlOperation, pending: { model: string; modes: string[]; expiresAt: string }): void {
    this.clearModelModeExpiry(operation.id);
    const delay = Math.max(0, Date.parse(pending.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      this.modelModeExpiryTimers.delete(operation.id);
      void this.expireModelMode(operation.id).catch((error) => this.options.logger.warn({ operationId: operation.id, error: safeLogError(error) }, "failed to expire model mode selection"));
    }, delay);
    timer.unref();
    this.modelModeExpiryTimers.set(operation.id, timer);
  }

  private clearModelModeExpiry(operationId: string): void {
    const timer = this.modelModeExpiryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.modelModeExpiryTimers.delete(operationId);
  }

  private async expireModelMode(operationId: string): Promise<void> {
    const operation = this.options.store.getPaneControlOperation(operationId);
    if (!operation || operation.state !== "applied" || operation.kind !== "model") return;
    const pending = pendingModelMode(operation.detail);
    if (!pending) return;
    if (Date.parse(pending.expiresAt) > Date.now()) { this.scheduleModelModeExpiry(operation, pending); return; }
    const claimed = this.options.store.claimAppliedPaneControlOperation(operation.id);
    if (!claimed) return;
    this.options.store.finishPaneControlOperation(claimed.id, "rejected", expiredModelModeDetail(pending));
    const binding = this.options.store.getBinding(operation.bindingId);
    if (binding) await this.updateModelModeFailure(binding, claimed, "模型模式选择已过期，请重新发送 `/model`。", "expired");
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: operation.bindingId });
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
function pendingModelMode(detail: string | null): { model: string; modes: string[]; expiresAt: string } | null { try { const value = JSON.parse(detail ?? "") as unknown; if (!value || typeof value !== "object") return null; const item = value as { phase?: unknown; model?: unknown; modes?: unknown; expiresAt?: unknown }; return item.phase === "waiting_for_mode" && typeof item.model === "string" && Array.isArray(item.modes) && item.modes.every((mode) => typeof mode === "string") && typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt)) ? { model: item.model, modes: item.modes as string[], expiresAt: item.expiresAt } : null; } catch { return null; } }
function modelOperationMatchesBinding(operation: PaneControlOperation, binding: Binding): boolean { return binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && binding.paneId === operation.paneId && binding.generation === operation.bindingGeneration && binding.traexSessionId === operation.terminalId; }
function expiredModelModeDetail(pending: { model: string; modes: string[]; expiresAt: string }): string { return JSON.stringify({ phase: "expired", model: pending.model, modes: pending.modes, expiresAt: pending.expiresAt }); }
class StaleModelModeError extends Error { constructor() { super("Binding identity changed before model mode input"); } }
class ExpiredModelModeError extends Error { constructor() { super("Model mode selection expired before input"); } }
function isApprovalPrompt(output: string): boolean { return /\b(?:approve|approval|required|allow this|waiting for user)\b|等待.*(?:批准|确认|用户)/iu.test(output); }
