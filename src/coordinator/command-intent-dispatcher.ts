import type { Logger } from "pino";
import type { CommandIntent, CommandIntentOutcome } from "../domain/command-intent.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { InstanceControlPort } from "../domain/ports/instance-workflows.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CommandIntentWorkflowStore } from "../domain/ports/swarm-command.js";
import type { PrimaryCardRedelivery } from "../domain/ports/primary-card-redelivery.js";
import { swarmCommandPolicy } from "../domain/swarm-command.js";
import type { Binding, IncomingLarkMessage } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { observeDetached } from "../runtime/work-lifecycle.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { RecoverySupervisorPort } from "./recovery-supervisor.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { OrchestratorClearWorkflow } from "./orchestrator-clear-workflow.js";
import type { SwarmCommandContextResolver } from "./swarm-command-context-resolver.js";

interface Options {
  store: CommandIntentWorkflowStore; primaryPrompts: Pick<InstanceStore, "getActiveOrdinaryPrompt">;
  resolver: SwarmCommandContextResolver; outbound: Pick<OutboundIntentPort, "enqueueCard">; logger: Logger;
  provisioning: BindingProvisioningWorkflowPort; modelSelection: ModelSelectionWorkflowPort; paneControl: PaneControlWorkflowPort;
  sessionAdministration: SessionAdministrationWorkflowPort; paneClosure: PaneClosureWorkflowPort;
  orchestratorClear?: Pick<OrchestratorClearWorkflow, "request">;
  recoverySupervisor: Pick<RecoverySupervisorPort, "recoverBinding">;
  primaryCardRedelivery: PrimaryCardRedelivery;
  instanceControl: Pick<InstanceControlPort, "createWorker">; wakeCardContext(): void;
  wakeOutbound?(): void;
  deferDispatchUntilRecovery?: boolean;
  presentation: Pick<ApplicationPresentation, "awakeStatus" | "requestRejected" | "commandResult" | "commandStatus">;
}

export class CommandIntentDispatcher {
  private readonly laneWorkers = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private accepting: boolean;
  constructor(private readonly options: Options) {
    this.accepting = !options.deferDispatchUntilRecovery;
  }

  async drain(intent: Pick<CommandIntent, "laneKey">): Promise<void> { await this.drainLane(intent.laneKey); }
  wake(intentId: string): void {
    if (!this.accepting) return;
    const intent = this.options.store.getCommandIntent(intentId);
    if (intent?.state === "accepted") void this.drainLane(intent.laneKey).catch((error) => this.options.logger.error({ event: "swarm-command-drain-failed", intentId, err: safeLogError(error), outcome: "deferred" }, "Swarm command drain failed; durable scan will retry"));
  }
  start(intervalMs: number): void {
    if (this.timer) return;
    this.accepting = true;
    this.timer = setInterval(() => {
      observeDetached(this.scanAccepted(), (error) => this.options.logger.error(
        { event: "swarm-command-periodic-scan-failed", err: safeLogError(error), outcome: "deferred" },
        "Swarm command periodic scan failed; durable scan will retry"
      ));
    }, intervalMs);
    this.timer.unref();
    void this.scanAccepted().catch((error) => this.options.logger.error({ event: "swarm-command-startup-scan-failed", err: safeLogError(error), outcome: "deferred" }, "Swarm command startup scan failed; durable scan will retry"));
  }
  async recover(): Promise<void> {
    const count = this.options.store.recoverExecutingCommandIntents(new Date().toISOString(), this.options.presentation.commandStatus);
    if (count) this.options.logger.warn({ event: "swarm-command-recovered", count, outcome: "uncertain" }, "terminalized interrupted swarm commands without replay");
    await this.scanAccepted();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    while (this.laneWorkers.size > 0) await Promise.allSettled([...this.laneWorkers.values()]);
  }

  private async scanAccepted(): Promise<void> {
    const lanes = new Set(this.options.store.listRecoverableCommandIntents().filter(({ state }) => state === "accepted").map(({ laneKey }) => laneKey));
    await Promise.all([...lanes].map((lane) => this.drainLane(lane)));
  }

  private async drainLane(laneKey: string): Promise<void> {
    const previous = this.laneWorkers.get(laneKey) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(async () => {
      for (let intent = this.options.store.claimNextCommandIntent(laneKey, this.options.presentation.commandStatus); intent; intent = this.options.store.claimNextCommandIntent(laneKey, this.options.presentation.commandStatus)) {
        this.options.logger.info({ event: "swarm-command-executing", intentId: intent.id, laneKey: intent.laneKey, commandKind: intent.command.kind, attemptCount: intent.attemptCount, outcome: "executing" }, "Swarm command execution started");
        this.options.wakeOutbound?.();
        await this.executeMutation(intent);
      }
    }).finally(() => { if (this.laneWorkers.get(laneKey) === worker) this.laneWorkers.delete(laneKey); });
    this.laneWorkers.set(laneKey, worker);
    await worker;
  }

  private async executeMutation(intent: CommandIntent): Promise<void> {
    const message = messageFrom(intent);
    const binding = intent.context.primary ? this.options.store.getBinding(intent.context.primary.bindingId) : null;
    let effectMayHaveStarted = false;
    let operation: Pick<CommandIntentOutcome, "operationKind" | "operationId"> = { operationKind: null, operationId: null };
    try {
      if (intent.context.primary && (!binding || !sameFrozenPrimary(binding, intent.context.primary))) {
        this.finish(intent, "rejected", "stale_context", "Primary context changed before command execution"); return;
      }
      const command = intent.command; let ok = true; let outcomeCode = "completed"; let outcomeDetail: string | null = null;
      if (intent.idempotencyKey.startsWith("primary-tool:") && intent.context.primary) {
        const current = this.options.primaryPrompts.getActiveOrdinaryPrompt(intent.context.primary.bindingId, intent.context.primary.bindingGeneration);
        if (!current || current.id !== intent.context.primary.activePromptId) {
          this.finish(intent, "rejected", "stale_context", "Primary tool turn changed before command execution"); return;
        }
      }
      if (swarmCommandPolicy(command).scope === "active-turn") {
        const current = this.options.resolver.resolve(message, command);
        if (current.outcome !== "resolved" || current.context.primary?.activePromptId !== intent.context.primary?.activePromptId) {
          this.finish(intent, "rejected", "stale_context", "Active turn changed before command execution"); return;
        }
      }
      effectMayHaveStarted = true;
      if (command.kind === "new") await this.options.provisioning.selectProject(message, command.title, null, command.agentKind);
      else if (command.kind === "reset") ok = await this.options.provisioning.reset(message, binding, command.title);
      else if (command.kind === "clear") {
        if (!binding || !this.options.orchestratorClear) throw new Error("Orchestrator context clear is unavailable");
        try {
          const clear = await this.options.orchestratorClear.request({
            id: `orchestrator-clear:${intent.id}`, idempotencyKey: `orchestrator-clear:${intent.id}`,
            bindingId: binding.id, actorOpenId: message.actorOpenId, sourceMessageId: intent.context.sourceMessageId,
            confirmationId: confirmationId(intent.idempotencyKey)
          });
          ok = clear.state !== "rejected" && clear.state !== "failed";
          outcomeCode = clear.state;
          outcomeDetail = clear.detail;
          operation = { operationKind: "orchestrator-clear", operationId: clear.id };
        } catch (error) {
          ok = false; outcomeCode = "rejected"; outcomeDetail = safeLogError(error).message;
          await this.reject(message, outcomeDetail, command.kind, "rejected");
        }
      }
      else if (command.kind === "attach") ok = await this.options.provisioning.attach(message, command.spaceName, command.paneId);
      else if (command.kind === "rename") ok = await this.options.sessionAdministration.rename(message, binding, command.title);
      else if (command.kind === "close") ok = await this.options.paneClosure.requestPaneClose(message, binding);
      else if (command.kind === "pane_close_request") ok = await this.options.paneClosure.requestPaneClose(message, binding);
      else if (command.kind === "pane_close_confirm") ok = await this.options.paneClosure.confirmPaneClose(message, binding, command.code);
      else if (command.kind === "reattach") {
        if (!binding || binding.attachment !== "orphaned") {
          ok = false;
          await this.reject(message, "当前会话不处于 orphaned 状态，无需重新连接。", command.kind, "not_orphaned");
        } else await this.options.provisioning.reattach(binding, command.paneId, message.actorOpenId);
      }
      else if (command.kind === "replace") {
        if (!binding || binding.attachment !== "orphaned") {
          ok = false;
          await this.reject(message, "只有 orphaned 会话可以创建 replacement Pane。", command.kind, "not_orphaned");
        } else await this.options.provisioning.replace(binding, message.actorOpenId);
      }
      else if (command.kind === "resume") ok = await this.options.sessionAdministration.resume(message, binding);
      else if (command.kind === "archive") ok = await this.options.sessionAdministration.archive(message, binding);
      else if (command.kind === "awake") {
        const result = await this.awake(intent, message, binding);
        ok = result.ok; outcomeCode = result.code; outcomeDetail = result.detail;
      }
      else if (command.kind === "stop") ok = await this.options.paneControl.stop(message, binding);
      else if (command.kind === "steer") {
        const result = await this.options.paneControl.steer(message, binding, command.text, intent.context.primary?.activePromptId ?? undefined);
        ok = result.accepted; outcomeCode = result.code; outcomeDetail = result.detail;
        operation = { operationKind: result.operationKind, operationId: result.operationId };
      }
      else if (command.kind === "model") ok = await this.options.modelSelection.runModel(message, binding, command.name);
      else if (command.kind === "worker_create") {
        if (!intent.context.projectId || !intent.context.primary) throw new Error("Worker creation requires Primary context");
        const result = await this.options.instanceControl.createWorker({ actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, projectId: intent.context.projectId, bindingId: intent.context.primary.bindingId, name: command.name, agentKind: command.agentKind, model: command.model, start: command.start });
        operation = { operationKind: "worker", operationId: result.instance.id };
        if (!intent.context.rootMessageId) throw new Error("Worker creation requires a Primary root message");
        const entryRegistered = this.options.store.registerWorkerThreadEntry({ commandIntentId: intent.id, workerId: result.instance.id, workerSessionGeneration: result.instance.workerSessionGeneration, bindingId: intent.context.primary.bindingId, bindingGeneration: intent.context.primary.bindingGeneration, rootMessageId: intent.context.rootMessageId });
        if (entryRegistered) this.options.wakeCardContext();
        if (result.status === "created-start-failed") { outcomeCode = "created_start_failed"; outcomeDetail = result.error; }
        if (intent.idempotencyKey.startsWith("lark-message:")) await this.reply(message, `Worker ${result.instance.name} 已创建${result.status === "created-start-failed" ? `，但启动失败：${result.error}` : "。"}`);
      } else throw new Error(`Query command ${command.kind} cannot execute as mutation`);
      const terminalCode = ok || command.kind === "steer" || command.kind === "awake" ? outcomeCode : "rejected";
      const terminalDetail = ok || command.kind === "steer" || command.kind === "awake" ? outcomeDetail : null;
      this.options.store.finishCommandIntent(intent.id, ok ? "succeeded" : "rejected", { code: terminalCode, detail: terminalDetail, ...operation }, this.options.presentation.commandStatus);
      this.options.logger.info({ event: "swarm-command-terminal", intentId: intent.id, laneKey: intent.laneKey, commandKind: intent.command.kind, outcome: ok ? "succeeded" : "rejected", outcomeCode: terminalCode }, "Swarm command execution settled");
      this.options.wakeOutbound?.();
    } catch (error) {
      const detail = safeLogError(error).message;
      this.options.store.finishCommandIntent(intent.id, effectMayHaveStarted ? "uncertain" : "failed", { code: effectMayHaveStarted ? "external_effect_uncertain" : "failed", detail, ...operation }, this.options.presentation.commandStatus);
      this.options.logger.warn({ event: "swarm-command-terminal", intentId: intent.id, laneKey: intent.laneKey, commandKind: intent.command.kind, err: safeLogError(error), outcome: effectMayHaveStarted ? "uncertain" : "failed" }, "Swarm command execution did not complete cleanly");
      this.options.wakeOutbound?.();
      await this.reject(message, detail, intent.command.kind, "failed");
    }
  }

  private finish(intent: CommandIntent, state: "rejected", code: string, detail: string): void { this.options.store.finishCommandIntent(intent.id, state, { code, detail, operationKind: null, operationId: null }, this.options.presentation.commandStatus); this.options.wakeOutbound?.(); }
  private async awake(intent: CommandIntent, message: IncomingLarkMessage, binding: Binding | null): Promise<{ ok: boolean; code: string; detail: string }> {
    if (!binding || !intent.context.primary) return { ok: false, code: "stale_context", detail: "Primary context is unavailable" };
    const recovery = await this.options.recoverySupervisor.recoverBinding(binding.id);
    if (recovery.outcome !== "busy") {
      const redelivery = this.options.primaryCardRedelivery.redeliver({
        commandIntentId: intent.id,
        bindingId: binding.id,
        expectedBindingGeneration: intent.context.primary.bindingGeneration
      });
      if (redelivery.outcome === "scheduled" || redelivery.outcome === "duplicate") {
        const duplicate = redelivery.outcome === "duplicate";
        const surface = redelivery.answerScheduled ? "Primary Main Card and latest Answer Card" : "Primary Main Card only; no eligible Answer Card exists";
        const catchUp = recovery.outcome === "requested"
          ? ` Core projection catch-up also requested ${recovery.promptCount} Primary Answer and ${recovery.workerTurnCount} Worker Task repairs.`
          : recovery.outcome === "needs_human" ? " Core projection still has evidence requiring human review." : " Core projection catch-up completed.";
        const detail = duplicate
          ? `This operation was already scheduled for redelivery: ${surface}.${catchUp} No Agent Input was submitted.`
          : `${surface} scheduled for redelivery through the durable outbox.${catchUp} No Agent Input was submitted.`;
        await this.awakeFeedback(message, { ...recovery, selectedStage: "delivering", stage: "delivering", redelivery: { outcome: redelivery.outcome, answerScheduled: redelivery.answerScheduled } });
        const code = duplicate ? "redelivery_already_scheduled"
          : recovery.outcome === "requested" ? "projection_recovery_and_redelivery_scheduled"
            : redelivery.answerScheduled ? "redelivery_scheduled" : "main_redelivery_scheduled";
        return { ok: true, code, detail };
      }
      const detail = `Card redelivery was not scheduled (${redelivery.reason}); Core projection catch-up ran, and no Agent Input was submitted.`;
      await this.awakeFeedback(message, { ...recovery, stage: "needs_human", redelivery: { outcome: "unavailable", reason: redelivery.reason } });
      return { ok: false, code: "redelivery_unavailable", detail };
    }
    const detail = "当前绑定仍在切换投影观察器，请稍后重试 `/swarm awake`；未安排卡片重新投递。";
    await this.awakeFeedback(message, recovery);
    return { ok: false, code: "recovery_unavailable", detail };
  }
  private async awakeFeedback(message: IncomingLarkMessage, result: import("../domain/recovery.js").RecoveryBindingResult): Promise<void> {
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `awake:${message.messageId}`, this.options.presentation.awakeStatus(result));
  }
  private async reject(message: IncomingLarkMessage, reason: string, kind: string, outcome: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-rejected:${message.messageId}:${kind}`, this.options.presentation.requestRejected(reason)); this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${kind}`, target: message.messageId, outcome }); }
  private async reply(message: IncomingLarkMessage, text: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-result:${message.messageId}`, this.options.presentation.commandResult({ title: "Swarm command", text })); }
}

function messageFrom(intent: CommandIntent): IncomingLarkMessage { return { eventId: `command:${intent.id}`, messageId: intent.context.sourceMessageId, parentMessageId: null, chatId: intent.context.chatId, topicId: intent.context.topicId, rootMessageId: intent.context.rootMessageId, actorOpenId: intent.context.actorOpenId, text: "", mentionsBot: true, isRootMessage: false }; }
function confirmationId(idempotencyKey: string): string { const match = /^natural-language-confirmation:([^:]+):clear$/.exec(idempotencyKey); return match?.[1] ?? idempotencyKey; }
function sameFrozenPrimary(binding: Binding, primary: NonNullable<CommandIntent["context"]["primary"]>): boolean {
  const native = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
  return binding.generation === primary.bindingGeneration && binding.paneId === primary.paneId && binding.traexSessionId === primary.terminalId
    && JSON.stringify(native) === JSON.stringify(primary.nativeSession);
}
