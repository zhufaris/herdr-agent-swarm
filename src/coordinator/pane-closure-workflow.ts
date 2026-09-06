import { createHash, randomBytes, randomUUID } from "node:crypto";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PaneCloseStore } from "../domain/ports/pane-operations.js";
import type { PanePresentation } from "../domain/ports/presentation.js";
import type { Binding, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import { evaluatePaneClosureSafety } from "../domain/pane-retention-policy.js";

interface Options { config: BridgeConfig; store: PaneCloseStore; herdr: Pick<HerdrPort, "closePane" | "getPane">; lifecycleEvents: LifecycleEventPublisher; outbound: Pick<OutboundIntentPort, "enqueueCard">; presentation: PanePresentation; isBindingBusy(bindingId: string): boolean; }
export interface PaneClosureWorkflowPort { recover(): Promise<void>; requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>; confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean>; }

export class PaneClosureWorkflow implements PaneClosureWorkflowPort {
  private readonly projectsById: Map<string, ProjectConfig>;
  constructor(private readonly options: Options) { this.projectsById = new Map(options.config.projects.map((project) => [project.id, project])); }

  async recover(): Promise<void> {
    const { store, herdr } = this.options;
    for (const step of store.listUnresolvedWorkerPaneCloseSteps()) {
      try {
        if (await herdr.getPane(step.paneId)) store.finishWorkerPaneCloseStep({ ...step, state: "uncertain", detail: "worker pane still present after restart; close was not replayed" });
        else store.finishWorkerPaneCloseStep({ ...step, state: "succeeded", detail: "worker pane absence verified after restart" });
      } catch (error) { store.finishWorkerPaneCloseStep({ ...step, state: "uncertain", detail: errorMessage(error) }); }
    }
    for (const operation of store.listUnresolvedPaneCloseOperations()) {
      const binding = store.getBinding(operation.bindingId);
      if (binding?.lifecycle === "closed" && binding.paneId === operation.paneId) { store.finishPaneCloseRequest(operation.id, "succeeded", "binding was already closed before recovery"); continue; }
      if (!binding || binding.paneId !== operation.paneId) { store.finishPaneCloseRequest(operation.id, "uncertain", "binding identity changed before recovery"); continue; }
      try {
        if (await herdr.getPane(operation.paneId)) { store.finishPaneCloseRequest(operation.id, "uncertain", "pane still present after restart; close was not replayed"); continue; }
        let next = store.transitionBinding(binding.id, { type: "archive_requested", hasActiveTurn: false }); next = store.transitionBinding(next.id, { type: "closed" });
        store.finishPaneCloseRequest(operation.id, "succeeded", "pane absence verified after restart");
        await this.publish(next.id, "BindingArchived", "bridge", { reason: "Herdr pane " + operation.paneId + " 的关闭结果已在 Bridge 重启后确认。" });
      } catch (error) { store.finishPaneCloseRequest(operation.id, "uncertain", errorMessage(error)); }
    }
  }

  async requestPaneClose(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    const checked = await this.checkSafety(message, binding); if (!checked) return false; const code = randomBytes(3).toString("hex").toUpperCase(); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    this.options.store.createPaneCloseRequest({ id: randomUUID(), bindingId: checked.binding.id, paneId: checked.pane.paneId, actorOpenId: message.actorOpenId, codeHash: hashCode(code), expiresAt });
    await this.reply(message, this.options.presentation.paneCloseConfirmation({ spaceName: this.spaceNameFor(checked.binding), paneId: checked.pane.paneId, agentState: checked.pane.agentState, code, expiresAt })); this.options.store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.requested", target: checked.binding.id, outcome: "confirmation_issued" }); return true;
  }

  async confirmPaneClose(message: IncomingLarkMessage, binding: Binding | null, code: string): Promise<boolean> {
    const { store, herdr } = this.options; if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可关闭的活动 Pane。"); return false; }
    const outcome = store.consumePaneCloseRequest({ bindingId: binding.id, paneId: binding.paneId, actorOpenId: message.actorOpenId, codeHash: hashCode(code), now: new Date().toISOString() });
    if (outcome.outcome !== "consumed") { const reason = outcome.outcome === "unauthorized" ? "只有发起关闭请求的用户可以确认。" : outcome.outcome === "expired" ? "确认码已过期，请重新发送 /swarm pane close。" : outcome.outcome === "stale" ? "没有待确认的关闭请求，请重新发送 /swarm pane close。" : "确认码无效。"; await this.reject(message, reason); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: outcome.outcome }); return false; }
    const checked = await this.checkSafety(message, store.getBinding(binding.id), outcome.paneId); if (!checked) { store.finishPaneCloseRequest(outcome.operationId, "rejected", "safety_recheck_failed"); return false; }
    try {
      const children = store.beginWorkerPaneCloseCascade({ operationId: outcome.operationId, bindingId: checked.binding.id, paneId: checked.pane.paneId, reason: `Parent pane ${checked.pane.paneId} closed` });
      let workerPaneSucceededCount = 0;
      let workerPaneUncertainCount = 0;
      for (const child of children) {
        try { await herdr.closePane(child.paneId); store.finishWorkerPaneCloseStep({ operationId: outcome.operationId, ...child, state: "succeeded", detail: "closed by parent pane cascade" }); workerPaneSucceededCount += 1; }
        catch (error) { store.finishWorkerPaneCloseStep({ operationId: outcome.operationId, ...child, state: "uncertain", detail: errorMessage(error) }); workerPaneUncertainCount += 1; }
      }
      await herdr.closePane(checked.pane.paneId); let next = store.transitionBinding(checked.binding.id, { type: "archive_requested", hasActiveTurn: false }); next = store.transitionBinding(next.id, { type: "closed" }); store.finishPaneCloseRequest(outcome.operationId, "succeeded"); await this.publish(next.id, "BindingArchived", "lark", { reason: "Herdr pane " + checked.pane.paneId + " 已由飞书确认关闭。" }); await this.reply(message, this.options.presentation.paneCloseResult({ paneId: checked.pane.paneId, workerPaneCount: children.length, workerPaneSucceededCount, workerPaneUncertainCount })); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.completed", target: checked.binding.id, outcome: workerPaneUncertainCount > 0 ? "closed_with_uncertain_workers" : "closed" }); return true;
    }
    catch (error) { store.finishPaneCloseRequest(outcome.operationId, "uncertain", errorMessage(error)); await this.reject(message, "Pane 关闭失败或无法验证：" + errorMessage(error)); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.failed", target: checked.binding.id, outcome: "unverified" }); return false; }
  }

  private async checkSafety(message: IncomingLarkMessage, binding: Binding | null, expectedPaneId?: string) {
    const { store, herdr } = this.options; if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") { await this.reject(message, "这个话题没有可关闭的活动 Pane。"); return null; }
    if (expectedPaneId !== undefined && binding.paneId !== expectedPaneId) { await this.reject(message, "Pane identity 已变化，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "identity_changed" }); return null; }
    if (this.options.isBindingBusy(binding.id) || store.countPendingPrompts(binding.id) > 0) { await this.reject(message, "当前 Pane 正在执行任务或仍有排队请求，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: "busy" }); return null; }
    const pane = await herdr.getPane(binding.paneId); if (!pane) { const orphaned = store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 1 }); await this.publish(orphaned.id, "BindingOrphaned", "herdr", { reason: "Herdr pane " + binding.paneId + " no longer exists" }); await this.reject(message, "Pane " + binding.paneId + " 已不存在，绑定已标记为 orphaned。"); return null; }
    const safety = evaluatePaneClosureSafety({ binding, pane, busy: this.options.isBindingBusy(binding.id), pendingWork: store.countPendingPrompts(binding.id) > 0, ...(expectedPaneId !== undefined ? { expectedPaneId } : {}) });
    if (!safety.allowed) { await this.reject(message, safety.reason === "pane runtime state is idle" || safety.reason === "pane runtime state is done" ? "Pane 状态不允许关闭。" : safety.reason === "pane runtime identity changed" ? "Pane identity 已变化，不能关闭。" : "当前 Pane 正在执行任务或仍有排队请求，不能关闭。"); store.audit({ actorOpenId: message.actorOpenId, action: "pane.close.rejected", target: binding.id, outcome: safety.reason }); return null; } return { binding, pane };
  }
  private spaceNameFor(binding: Binding): string { const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined; return project ? projectSpaceName(project) : "legacy/unresolved"; }
  private async reply(message: IncomingLarkMessage, card: object): Promise<void> { const root = message.rootMessageId ?? message.messageId; await this.options.outbound.enqueueCard(root, "standalone:" + root + ":" + JSON.stringify(card), card); }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, "rejected:" + message.messageId, this.options.presentation.requestRejected(reason)); }
  private async publish(bindingId: string, type: Parameters<typeof createBridgeEvent>[1], origin: Parameters<typeof createBridgeEvent>[2], payload: Parameters<typeof createBridgeEvent>[3]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload) as ReturnType<typeof createBridgeEvent>); }
}

function hashCode(code: string): string { return createHash("sha256").update(code.trim().toUpperCase()).digest("hex"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
