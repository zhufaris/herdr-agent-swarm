import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderModelModeCard, renderModelResultCard } from "../cards/model-card.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort, OperationsStore, OutboundIntentPort } from "../domain/ports.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage, PaneControlOperation, ProjectConfig } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";
import { requireMatchingPane } from "./pane-runtime-identity.js";
interface Options { config: BridgeConfig; store: OperationsStore; herdr: HerdrPort; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; logger: Logger; }

const MODEL_MODE_SELECTION_TTL_MS = 5 * 60_000;

export interface ModelSelectionWorkflowPort {
  recover(): Promise<void>;
  shutdown(): void;
  runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean>;
  selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void>;
  selectModelMode(action: IncomingLarkCardAction, bindingId: string, operationId: string, mode: string): Promise<void>;
  execute(operation: PaneControlOperation, binding: Binding): Promise<void>;
}

export class ModelSelectionWorkflow implements ModelSelectionWorkflowPort {
  private readonly modelModeExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly projectsById: Map<string, ProjectConfig>;
  private readonly uniqueProjectByWorkspace: Map<string, ProjectConfig | null>;

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    this.uniqueProjectByWorkspace = uniqueProjectsByWorkspace(options.config.projects);
  }

  shutdown(): void {
    for (const timer of this.modelModeExpiryTimers.values()) clearTimeout(timer);
    this.modelModeExpiryTimers.clear();
  }

  async recover(): Promise<void> {
    const { store } = this.options;
    for (const operation of store.listRecoverablePaneControlOperations()) {
      if (operation.kind !== "model") continue;
      const pending = pendingModelMode(operation.detail);
      if (pending && Date.parse(pending.expiresAt) > Date.now()) { this.scheduleModelModeExpiry(operation, pending); continue; }
      if (pending) {
        this.clearModelModeExpiry(operation.id);
        store.finishPaneControlOperation(operation.id, "rejected", expiredModelModeDetail(pending));
        const binding = store.getBinding(operation.bindingId);
        if (binding) await this.updateModelModeFailure(binding, operation, "模型模式选择已过期，请重新发送 `/swarm model`。", "expired");
        continue;
      }
      store.finishPaneControlOperation(operation.id, "uncertain", "Bridge restarted after pane input may have been sent; operation was not replayed");
    }
  }
  async execute(operation: PaneControlOperation, binding: Binding): Promise<void> {
    if (this.options.activeTurn(binding.id) || binding.lastAgentState === "working" || binding.lastAgentState === "blocked") {
      this.options.store.finishPaneControlOperation(operation.id, "rejected", "Pane was not idle when model control was claimed");
      return;
    }
    await this.runAcceptedModel(operation, binding.rootMessageId ?? operation.sourceMessageId, operation.payload);
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
      await this.updateModelModeFailure(binding, operation, "模型模式选择已失效，请重新发送 `/swarm model`。", "stale");
      return;
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      const rejected = store.rejectAppliedPaneControlOperation(operation.id, expiredModelModeDetail(pending));
      if (!rejected) return;
      this.clearModelModeExpiry(rejected.id);
      await this.updateModelModeFailure(binding, rejected, "模型模式选择已过期，请重新发送 `/swarm model`。", "expired");
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return;
    }
    if (!modelOperationMatchesBinding(operation, binding)) {
      const claimed = store.claimAppliedPaneControlOperation(operation.id);
      if (!claimed) return;
      this.clearModelModeExpiry(claimed.id);
      store.finishPaneControlOperation(claimed.id, "rejected", "Binding identity changed before model mode selection");
      await this.updateModelModeFailure(binding, claimed, "Pane identity 已变化，请重新发送 `/swarm model`。", "stale-identity");
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return;
    }
    try {
      let currentBinding = store.getBinding(binding.id);
      if (!currentBinding || !modelOperationMatchesBinding(operation, currentBinding)) throw new StaleModelModeError();
      const pane = await requireMatchingPane(this.options.herdr, this.projectsById, currentBinding, operation.paneId);
      currentBinding = store.getBinding(binding.id);
      if (!currentBinding || !modelOperationMatchesBinding(operation, currentBinding)) throw new StaleModelModeError();
      if (Date.parse(pending.expiresAt) <= Date.now()) throw new ExpiredModelModeError();
      const claimed = store.claimAppliedPaneControlOperation(operation.id);
      if (!claimed) return;
      this.clearModelModeExpiry(claimed.id);
      await herdr.completePaneModelMode(pane.paneId, mode, config.commandTimeoutMs);
      const output = await herdr.runPaneCommand!(pane.paneId, "/model", config.commandTimeoutMs);
      store.finishPaneControlWithResult({
        operationId: claimed.id, state: "confirmed", detail: "Model selection confirmed: " + pending.model + " / " + mode,
        result: { kind: "card_update", targetMessageId: claimed.sourceMessageId, idempotencyKey: "card-update:" + claimed.sourceMessageId + ":model:" + claimed.id + ":confirmed", card: renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: true }) }
      });
      this.options.outboundWork.wake();
      store.audit({ actorOpenId: action.operatorOpenId, action: "model.mode", target: pending.model + "/" + mode, outcome: "switch_completed" });
    } catch (error) {
      const stale = error instanceof StaleModelModeError;
      const expired = error instanceof ExpiredModelModeError;
      const current = store.getPaneControlOperation(operation.id);
      if (current?.state === "applied") store.finishPaneControlOperation(operation.id, "rejected", stale ? "Binding identity changed before model mode input" : expired ? expiredModelModeDetail(pending) : "Model mode validation failed before input: " + errorMessage(error));
      else if (current?.state === "running") store.finishPaneControlOperation(operation.id, stale || expired ? "rejected" : "uncertain", stale ? "Binding identity changed before model mode input" : expired ? expiredModelModeDetail(pending) : "Model mode may have applied: " + errorMessage(error));
      const failed = store.getPaneControlOperation(operation.id) ?? operation;
      await this.updateModelModeFailure(binding, failed, stale ? "Pane identity 已变化，请重新发送 `/swarm model`。" : expired ? "模型模式选择已过期，请重新发送 `/swarm model`。" : "模型模式选择无法确认：" + errorMessage(error), stale ? "stale-identity" : expired ? "expired" : current?.state === "running" ? "uncertain" : "failed-before-input");
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
      const pane = await requireMatchingPane(this.options.herdr, this.projectsById, binding, operation.paneId);
      if (name) {
        if (!herdr.beginPaneModelSelection) throw new Error("当前 Herdr adapter 不支持交互式模型选择。");
        const selection = await herdr.beginPaneModelSelection(pane.paneId, name, config.commandTimeoutMs);
        if (selection.kind === "mode_required") {
          const expiresAt = new Date(Date.now() + MODEL_MODE_SELECTION_TTL_MS).toISOString();
          const card = renderModelModeCard({ bindingId: binding.id, operationId: operation.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, model: name, modes: selection.modes });
          this.finishModelWithResult(operation, rootMessageId, "applied", JSON.stringify({ phase: "waiting_for_mode", model: name, modes: selection.modes, expiresAt }), "mode-required", card);
          this.scheduleModelModeExpiry(operation, { model: name, modes: selection.modes, expiresAt });
          store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name, outcome: "mode_required" });
          return true;
        }
      }
      const output = await herdr.runPaneCommand!(pane.paneId, "/model", config.commandTimeoutMs);
      const card = renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: pane.paneId, output, switched: name !== null });
      this.finishModelWithResult(operation, rootMessageId, "confirmed", name ? "Model selection confirmed" : "Model selector listed", "confirmed", card);
      store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name ?? "list", outcome: name ? "switch_completed" : "list_completed" });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return true;
    } catch (error) {
      const failure = `模型命令执行失败或无法确认：${errorMessage(error)}`;
      const card = operation.idempotencyKey.startsWith("card:")
        ? renderModelResultCard({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: operation.paneId, output: failure, switched: false })
        : renderMessageRejectedCard(failure);
      this.finishModelWithResult(operation, rootMessageId, "uncertain", `Model operation may have applied: ${errorMessage(error)}`, "uncertain", card);
      store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: name ?? "list", outcome: "uncertain" });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return false;
    }
  }

  private acceptControl(input: { message: IncomingLarkMessage; binding: Binding; kind: PaneControlOperation["kind"]; payload?: string; parentPromptId?: string }): { operation: PaneControlOperation; inserted: boolean } {
    const terminalId = input.binding.traexSessionId;
    return this.options.store.acceptPaneControlOperation({
      id: randomUUID(), idempotencyKey: `message:${input.message.messageId}:${input.kind}`, bindingId: input.binding.id, paneId: input.binding.paneId!, terminalId,
      bindingGeneration: input.binding.generation, kind: input.kind, payload: input.payload ?? null, parentPromptId: input.parentPromptId ?? null,
      actorOpenId: input.message.actorOpenId, sourceMessageId: input.message.messageId
    });
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
    const rejected = this.options.store.rejectAppliedPaneControlOperation(operation.id, expiredModelModeDetail(pending));
    if (!rejected) return;
    const binding = this.options.store.getBinding(operation.bindingId);
    if (binding) await this.updateModelModeFailure(binding, rejected, "模型模式选择已过期，请重新发送 `/swarm model`。", "expired");
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: operation.bindingId });
  }

  private spaceNameFor(binding: Binding): string { const project = binding.projectId ? this.projectsById.get(binding.projectId) : this.uniqueProjectByWorkspace.get(binding.workspaceId); return project ? projectSpaceName(project) : "legacy/unresolved"; }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private finishModelWithResult(operation: PaneControlOperation, rootMessageId: string, state: "applied" | "confirmed" | "uncertain", detail: string, outcome: "confirmed" | "mode-required" | "uncertain", card: object): void {
    const cardAction = operation.idempotencyKey.startsWith("card:");
    this.options.store.finishPaneControlWithResult({
      operationId: operation.id, state, detail,
      result: cardAction
        ? { kind: "card_update", targetMessageId: operation.sourceMessageId, idempotencyKey: `card-update:${operation.sourceMessageId}:model:${operation.id}:${outcome}`, card }
        : { kind: "card_reply", targetMessageId: rootMessageId, idempotencyKey: `model:${operation.id}:${outcome}`, targetRole: "operation_result", card }
    });
    this.options.outboundWork.wake();
  }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
}

function uniqueProjectsByWorkspace(projects: readonly ProjectConfig[]): Map<string, ProjectConfig | null> {
  const result = new Map<string, ProjectConfig | null>();
  for (const project of projects) result.set(project.workspaceId, result.has(project.workspaceId) ? null : project);
  return result;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function pendingModelMode(detail: string | null): { model: string; modes: string[]; expiresAt: string } | null { try { const value = JSON.parse(detail ?? "") as unknown; if (!value || typeof value !== "object") return null; const item = value as { phase?: unknown; model?: unknown; modes?: unknown; expiresAt?: unknown }; return item.phase === "waiting_for_mode" && typeof item.model === "string" && Array.isArray(item.modes) && item.modes.every((mode) => typeof mode === "string") && typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt)) ? { model: item.model, modes: item.modes as string[], expiresAt: item.expiresAt } : null; } catch { return null; } }
function modelOperationMatchesBinding(operation: PaneControlOperation, binding: Binding): boolean { return binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && binding.paneId === operation.paneId && binding.generation === operation.bindingGeneration && (binding.traexSessionId === operation.terminalId || hasNativeAgentSession(binding)); }
function hasNativeAgentSession(binding: Binding): boolean { return Boolean(binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue); }
function expiredModelModeDetail(pending: { model: string; modes: string[]; expiresAt: string }): string { return JSON.stringify({ phase: "expired", model: pending.model, modes: pending.modes, expiresAt: pending.expiresAt }); }
class StaleModelModeError extends Error { constructor() { super("Binding identity changed before model mode input"); } }
class ExpiredModelModeError extends Error { constructor() { super("Model mode selection expired before input"); } }
function isApprovalPrompt(output: string): boolean { return /\b(?:approve|approval|required|allow this|waiting for user)\b|等待.*(?:批准|确认|用户)/iu.test(output); }
