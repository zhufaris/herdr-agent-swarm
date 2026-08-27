import { randomUUID } from "node:crypto";
import type { HerdrPort, OperationsStore, OutboundIntentPort } from "../domain/ports.js";
import type { Binding, IncomingLarkMessage, PaneControlOperation } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";

interface Options { store: Pick<OperationsStore, "acceptPaneControlOperation" | "audit" | "claimNextPaneControlOperation" | "claimPaneControlOperation" | "finishPaneControlOperation" | "getBinding" | "listBindings" | "listRecoverablePaneControlOperations">; herdr: Pick<HerdrPort, "readOutput" | "sendEscape" | "steerPrompt">; outbound: Pick<OutboundIntentPort, "enqueueCard">; scheduler: PromptWorkScheduler; model: Pick<ModelSelectionWorkflowPort, "execute" | "recover">; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; }
export interface PaneControlWorkflowPort { recover(): Promise<void>; drainPaneControls(bindingId: string): Promise<void>; stop(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean>; steer(message: IncomingLarkMessage, binding: Binding | null, text: string, expectedParentPromptId?: string): Promise<boolean>; }

export class PaneControlWorkflow implements PaneControlWorkflowPort {
  private readonly workers = new Map<string, Promise<void>>();
  constructor(private readonly options: Options) {}

  async recover(): Promise<void> {
    await this.options.model.recover();
    for (const operation of this.options.store.listRecoverablePaneControlOperations()) {
      if (operation.kind !== "model") this.options.store.finishPaneControlOperation(operation.id, "uncertain", "Bridge restarted after pane input may have been sent; operation was not replayed");
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
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") { await this.reject(message, "当前话题没有可 steering 的活动任务。"); return false; }
    const active = this.options.activeTurn(binding.id);
    if (!active || active.paneId !== binding.paneId || (expectedParentPromptId && active.promptId !== expectedParentPromptId) || !this.options.herdr.steerPrompt) { await this.reject(message, "当前没有可 steering 的活动 TraeX 任务。`/swarm steer` 未进入任务队列。"); return false; }
    const accepted = this.accept({ message, binding, kind: "steer", payload: text, parentPromptId: active.promptId });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
    return true;
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
    const active = this.options.activeTurn(binding.id);
    if (!active || active.promptId !== operation.parentPromptId || active.paneId !== operation.paneId || !this.options.herdr.steerPrompt || !operation.payload) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "TraeX is no longer steerable; text was not injected"); return; }
    try {
      const tail = await this.options.herdr.readOutput(operation.paneId, 80);
      if (isApprovalPrompt(tail)) { this.options.store.finishPaneControlOperation(operation.id, "rejected", "TraeX approval remains local to Herdr; steering text was not injected"); return; }
      const result = await this.options.herdr.steerPrompt(operation.paneId, operation.payload);
      this.options.store.finishPaneControlOperation(operation.id, result === "injected" ? "confirmed" : "rejected", result === "injected" ? "Steering injected into active turn" : "TraeX is no longer steerable; text was not injected");
      this.options.store.audit({ actorOpenId: operation.actorOpenId, action: "prompt.steer", target: binding.id, outcome: result });
    } catch (error) { this.options.store.finishPaneControlOperation(operation.id, "uncertain", "Steering result cannot be confirmed: " + errorMessage(error)); }
  }

  private accept(input: { message: IncomingLarkMessage; binding: Binding; kind: PaneControlOperation["kind"]; payload?: string; parentPromptId?: string }) {
    return this.options.store.acceptPaneControlOperation({ id: randomUUID(), idempotencyKey: "message:" + input.message.messageId + ":" + input.kind, bindingId: input.binding.id, paneId: input.binding.paneId!, terminalId: input.binding.traexSessionId, bindingGeneration: input.binding.generation, kind: input.kind, payload: input.payload ?? null, parentPromptId: input.parentPromptId ?? null, actorOpenId: input.message.actorOpenId, sourceMessageId: input.message.messageId });
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, "rejected:" + message.messageId, renderMessageRejectedCard(reason)); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isApprovalPrompt(output: string): boolean { return /\b(?:approve|approval|required|allow this|waiting for user)\b|等待.*(?:批准|确认|用户)/iu.test(output); }
