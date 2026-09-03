import { randomUUID } from "node:crypto";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PaneControlStore } from "../domain/ports/pane-operations.js";
import type { Binding, IncomingLarkMessage, PaneControlOperation } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { TurnControlWorkflow } from "./turn-control-workflow.js";

interface Options { store: PaneControlStore; herdr: Pick<HerdrPort, "sendEscape">; outbound: Pick<OutboundIntentPort, "enqueueCard">; scheduler: PromptWorkScheduler; model: Pick<ModelSelectionWorkflowPort, "execute" | "recover">; turnControl: Pick<TurnControlWorkflow, "steer" | "recover">; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; }
export interface PaneControlWorkflowPort { recover(): Promise<void>; drainPaneControls(bindingId: string): Promise<void>; stop(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>; steer(message: IncomingLarkMessage, binding: Binding | null, text: string, expectedParentPromptId?: string): Promise<boolean>; }

export class PaneControlWorkflow implements PaneControlWorkflowPort {
  private readonly workers = new Map<string, Promise<void>>();
  constructor(private readonly options: Options) {}

  async recover(): Promise<void> {
    await this.options.model.recover();
    await this.options.turnControl.recover();
    for (const operation of this.options.store.listRecoverablePaneControlOperations()) {
      if (operation.kind === "steer") this.options.store.finishPaneControlOperation(operation.id, operation.state === "accepted" ? "rejected" : "uncertain", operation.state === "accepted" ? "Legacy steering was retired before dispatch" : "Legacy steering may have reached the runtime and was not replayed");
      else if (operation.kind !== "model") this.options.store.finishPaneControlOperation(operation.id, "uncertain", "Bridge restarted after pane input may have been sent; operation was not replayed");
    }
    for (const binding of this.options.store.listBindings()) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
  }

  async drainPaneControls(bindingId: string): Promise<void> {
    const previous = this.workers.get(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainOnce(bindingId)).finally(() => { if (this.workers.get(bindingId) === worker) this.workers.delete(bindingId); });
    this.workers.set(bindingId, worker);
    await worker;
  }

  async stop(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可停止的活动任务。`/swarm stop` 未进入任务队列。"); return false; }
    const active = this.options.activeTurn(binding.id);
    if (!active || active.paneId !== binding.paneId || !this.options.herdr.sendEscape) { await this.reject(message, "当前没有可停止的活动 TraeX 任务。`/swarm stop` 未进入任务队列。"); return false; }
    const accepted = this.accept({ message, binding, kind: "stop", parentPromptId: active.promptId });
    if (accepted.inserted) { const claimed = this.options.store.claimPaneControlOperation(accepted.operation.id); if (claimed) await this.executeStop(claimed, binding); else this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id }); }
    return true;
  }

  async steer(message: IncomingLarkMessage, binding: Binding | null, text: string, expectedParentPromptId?: string): Promise<boolean> {
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可 steering 的活动任务。`/swarm steer` 未进入任务队列。"); return false; }
    try {
      if (expectedParentPromptId) {
        const active = this.options.activeTurn(binding.id);
        if (active && active.promptId !== expectedParentPromptId) { await this.reject(message, "目标 turn 已变化。`/swarm steer` 未进入任务队列。"); return false; }
      }
      const result = await this.options.turnControl.steer({ owner: { kind: "binding", id: binding.id }, actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, text, idempotencyKey: `message:${message.messageId}:steer`, sourceMessageId: message.messageId, resultTargetMessageId: message.rootMessageId ?? message.messageId });
      return result.operation.state === "delivered";
    } catch (error) { await this.reject(message, `Steer 未发送：${errorMessage(error)}`); return false; }
  }

  private async drainOnce(bindingId: string): Promise<void> {
    for (let operation = this.options.store.claimNextPaneControlOperation(bindingId); operation; operation = this.options.store.claimNextPaneControlOperation(bindingId)) {
      const binding = this.options.store.getBinding(operation.bindingId);
      if (!binding || binding.paneId !== operation.paneId || binding.generation !== operation.bindingGeneration) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "Pane identity changed before control dispatch"); continue; }
      if (operation.kind === "stop") await this.executeStop(operation, binding);
      else if (operation.kind === "steer") await this.executeSteer(operation, binding);
      else await this.options.model.execute(operation, binding);
    }
  }

  private async executeStop(operation: PaneControlOperation, binding: Binding): Promise<void> {
    if (!this.options.activeTurn(binding.id) || !this.options.herdr.sendEscape) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "No supervised active turn remains for Esc"); return; }
    try { await this.options.herdr.sendEscape(operation.paneId); this.options.store.finishPaneControlOperation(operation.id, "applied", "Esc sent; awaiting runtime observation"); this.options.store.audit({ actorOpenId: operation.actorOpenId, action: "prompt.stop", target: binding.id, outcome: "esc_sent" }); }
    catch (error) { this.options.store.finishPaneControlOperation(operation.id, "uncertain", "Esc result cannot be confirmed: " + errorMessage(error)); }
  }

  private async executeSteer(operation: PaneControlOperation, binding: Binding): Promise<void> {
    void binding;
    this.options.store.finishPaneControlOperation(operation.id, "rejected", "Steering is unsupported; text was not injected");
  }

  private accept(input: { message: IncomingLarkMessage; binding: Binding; kind: PaneControlOperation["kind"]; payload?: string; parentPromptId?: string }) {
    return this.options.store.acceptPaneControlOperation({ id: randomUUID(), idempotencyKey: "message:" + input.message.messageId + ":" + input.kind, bindingId: input.binding.id, paneId: input.binding.paneId!, terminalId: input.binding.traexSessionId, bindingGeneration: input.binding.generation, kind: input.kind, payload: input.payload ?? null, parentPromptId: input.parentPromptId ?? null, actorOpenId: input.message.actorOpenId, sourceMessageId: input.message.messageId });
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, "rejected:" + message.messageId, renderMessageRejectedCard(reason)); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
