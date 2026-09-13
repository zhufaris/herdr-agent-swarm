import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CreateWorkerResult } from "../domain/agent-instance.js";
import type { CommandIntent, CommandIntentOutcome } from "../domain/command-intent.js";
import type { CommandIntentWorkflowStore } from "../domain/ports/swarm-command.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { swarmCommandPolicy } from "../domain/swarm-command.js";
import type { BridgeCommand, Binding, IncomingLarkCardAction, IncomingLarkMessage } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { InstanceControlWorkflow } from "./instance-control-workflow.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { OperationsQueryWorkflowPort } from "./operations-query-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import { SwarmCommandContextResolver } from "./swarm-command-context-resolver.js";

interface Options {
  store: CommandIntentWorkflowStore; primaryPrompts: Pick<InstanceStore, "getActiveOrdinaryPrompt">;
  resolver: SwarmCommandContextResolver; outbound: Pick<OutboundIntentPort, "enqueueCard">; logger: Logger;
  provisioning: BindingProvisioningWorkflowPort; modelSelection: ModelSelectionWorkflowPort; paneControl: PaneControlWorkflowPort;
  operationsQuery: OperationsQueryWorkflowPort; sessionAdministration: SessionAdministrationWorkflowPort; paneClosure: PaneClosureWorkflowPort;
  promptRun: PromptRunWorkflowPort; instanceControl: Pick<InstanceControlWorkflow, "createWorker" | "inspect">;
  presentation: Pick<ApplicationPresentation, "help" | "awakeStatus" | "skipStatus" | "requestRejected" | "commandResult">;
}

export interface SwarmCommandGatewayPort {
  handle(message: IncomingLarkMessage, command: BridgeCommand): Promise<void>;
  createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult>;
  createWorkerFromPrimaryTool(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: Extract<BridgeCommand, { kind: "worker_create" }> }): Promise<CreateWorkerResult>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

export class SwarmCommandGateway implements SwarmCommandGatewayPort {
  private readonly laneWorkers = new Map<string, Promise<void>>();
  private readonly workerResults = new Map<string, CreateWorkerResult>();
  constructor(private readonly options: Options) {}

  async handle(message: IncomingLarkMessage, command: BridgeCommand): Promise<void> {
    const resolved = this.options.resolver.resolve(message, command);
    if (resolved.outcome === "rejected") return this.reject(message, resolved.message, command.kind, resolved.code);
    const policy = swarmCommandPolicy(command);
    if (policy.mode === "query") {
      await this.executeQuery(message, command, resolved.binding);
      this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${command.kind}`, target: resolved.laneKey, outcome: "success" });
      return;
    }
    const accepted = this.options.store.acceptCommandIntent({ id: randomUUID(), idempotencyKey: `lark-message:${message.messageId}:${command.kind}`, laneKey: resolved.laneKey, command, context: resolved.context, replayPolicy: policy.replay as Exclude<typeof policy.replay, "none">, acceptedAt: new Date().toISOString() });
    if (accepted.outcome === "conflict") return this.reject(message, "命令幂等标识已用于不同请求。", command.kind, "idempotency_conflict");
    await this.drainLane(accepted.intent.laneKey);
  }

  async createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult> {
    const binding = this.options.store.getBinding(bindingId);
    const message: IncomingLarkMessage = { eventId: `card:${action.messageId}`, messageId: action.messageId, parentMessageId: null, chatId: action.chatId, topicId: binding?.topicId ?? null, rootMessageId: binding?.rootMessageId ?? action.messageId, actorOpenId: action.operatorOpenId, text: "/swarm worker create", mentionsBot: true, isRootMessage: false };
    const resolved = this.options.resolver.resolve(message, command, bindingId);
    if (resolved.outcome === "rejected") throw new Error(resolved.message);
    const requestFingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const accepted = this.options.store.acceptCommandIntent({ id: randomUUID(), idempotencyKey: `lark-card:${action.messageId}:worker-create:${action.operatorOpenId}:${requestFingerprint}`, laneKey: resolved.laneKey, command, context: resolved.context, replayPolicy: "reconcilable", acceptedAt: new Date().toISOString() });
    if (accepted.outcome === "conflict") throw new Error("命令幂等标识已用于不同请求。");
    return this.resultForWorkerCreate(accepted.intent.id, accepted.intent.laneKey);
  }

  async createWorkerFromPrimaryTool(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: Extract<BridgeCommand, { kind: "worker_create" }> }): Promise<CreateWorkerResult> {
    const binding = this.options.store.getBinding(input.bindingId);
    if (!binding || binding.generation !== input.bindingGeneration || binding.rootMessageId !== input.rootMessageId) throw new Error("Primary tool context is stale");
    const prompt = this.options.primaryPrompts.getActiveOrdinaryPrompt(input.bindingId, input.bindingGeneration);
    if (!prompt || prompt.id !== input.parentPromptId || prompt.larkMessageId !== input.sourceMessageId) throw new Error("Primary tool active prompt changed");
    const message: IncomingLarkMessage = { eventId: `primary-tool:${input.parentPromptId}:${input.idempotencyKey}`, messageId: input.sourceMessageId, parentMessageId: null, chatId: binding.chatId, topicId: binding.topicId, rootMessageId: input.rootMessageId, actorOpenId: prompt.actorOpenId, text: "Primary tool worker create", mentionsBot: true, isRootMessage: false };
    const resolved = this.options.resolver.resolve(message, input.command, input.bindingId);
    if (resolved.outcome === "rejected") throw new Error(resolved.message);
    const context = { ...resolved.context, primary: { ...resolved.context.primary!, activePromptId: input.parentPromptId } };
    const accepted = this.options.store.acceptCommandIntent({ id: randomUUID(), idempotencyKey: `primary-tool:${input.bindingId}:${input.bindingGeneration}:${input.parentPromptId}:${input.idempotencyKey}`, laneKey: resolved.laneKey, command: input.command, context, replayPolicy: "reconcilable", acceptedAt: new Date().toISOString() });
    if (accepted.outcome === "conflict") throw new Error("Idempotency key was already used for a different Worker creation request");
    return this.resultForWorkerCreate(accepted.intent.id, accepted.intent.laneKey);
  }

  private async resultForWorkerCreate(intentId: string, laneKey: string): Promise<CreateWorkerResult> {
    await this.drainLane(laneKey);
    const result = this.workerResults.get(intentId);
    if (result) return result;
    const current = this.options.store.getCommandIntent(intentId);
    const workerId = current?.outcome?.operationKind === "worker" ? current.outcome.operationId : null;
    if (workerId) {
      const instance = this.options.instanceControl.inspect(workerId).instance;
      return current?.outcome?.code === "created_start_failed"
        ? { status: "created-start-failed", instance, error: current.outcome.detail ?? "Worker start failed" }
        : { status: "created", instance };
    }
    throw new Error(current?.outcome?.detail ?? "Worker creation did not complete");
  }

  async recover(): Promise<void> {
    const count = this.options.store.recoverExecutingCommandIntents(new Date().toISOString());
    if (count) this.options.logger.warn({ event: "swarm-command-recovered", count, outcome: "uncertain" }, "terminalized interrupted swarm commands without replay");
    const lanes = new Set(this.options.store.listRecoverableCommandIntents().filter(({ state }) => state === "accepted").map(({ laneKey }) => laneKey));
    await Promise.all([...lanes].map((lane) => this.drainLane(lane)));
  }

  async stop(): Promise<void> {
    while (this.laneWorkers.size > 0) await Promise.allSettled([...this.laneWorkers.values()]);
  }

  private async drainLane(laneKey: string): Promise<void> {
    const previous = this.laneWorkers.get(laneKey) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(async () => {
      for (let intent = this.options.store.claimNextCommandIntent(laneKey); intent; intent = this.options.store.claimNextCommandIntent(laneKey)) await this.executeMutation(intent);
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
      if (swarmCommandPolicy(command).scope === "active-turn" && command.kind !== "skip") {
        const current = this.options.resolver.resolve(message, command);
        if (current.outcome !== "resolved" || current.context.primary?.activePromptId !== intent.context.primary?.activePromptId) {
          this.finish(intent, "rejected", "stale_context", "Active turn changed before command execution"); return;
        }
      }
      effectMayHaveStarted = true;
      if (command.kind === "new") await this.options.provisioning.selectProject(message, command.title);
      else if (command.kind === "reset") ok = await this.options.provisioning.reset(message, binding, command.title);
      else if (command.kind === "attach") ok = await this.options.provisioning.attach(message, command.spaceName, command.paneId);
      else if (command.kind === "rename") ok = await this.options.sessionAdministration.rename(message, binding, command.title);
      else if (command.kind === "close") ok = await this.options.sessionAdministration.archive(message, binding);
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
      else if (command.kind === "awake") ok = await this.awake(message, binding);
      else if (command.kind === "skip") {
        if (!binding || !intent.context.primary) { ok = false; outcomeCode = "rejected"; }
        else {
          const result = this.options.promptRun.skipDetached(binding.id, intent.context.primary.bindingGeneration, message.actorOpenId, message.messageId, message.rootMessageId);
          ok = result.outcome !== "stale"; outcomeCode = result.outcome; outcomeDetail = result.outcome === "skipped" ? result.promptId : null;
          const detail = result.outcome === "skipped"
            ? `已跳过 detached prompt \`${result.promptId.slice(0, 12)}\`；此前执行结果仍不确定，任务不会自动重放。`
            : result.outcome === "none" ? "当前没有 detached prompt，无需跳过。" : "Primary 上下文已变化，未跳过任何 prompt。";
          await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `skip:${message.messageId}`, this.options.presentation.skipStatus(detail, result.outcome));
        }
      }
      else if (command.kind === "stop") ok = await this.options.paneControl.stop(message, binding);
      else if (command.kind === "steer") ok = await this.options.paneControl.steer(message, binding, command.text, intent.context.primary?.activePromptId ?? undefined);
      else if (command.kind === "model") ok = await this.options.modelSelection.runModel(message, binding, command.name);
      else if (command.kind === "worker_create") {
        if (!intent.context.projectId || !intent.context.primary) throw new Error("Worker creation requires Primary context");
        const result = await this.options.instanceControl.createWorker({ actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, projectId: intent.context.projectId, bindingId: intent.context.primary.bindingId, name: command.name, agentKind: command.agentKind, model: command.model, start: command.start });
        this.workerResults.set(intent.id, result); operation = { operationKind: "worker", operationId: result.instance.id };
        if (!intent.context.rootMessageId) throw new Error("Worker creation requires a Primary root message");
        this.options.store.registerWorkerThreadEntry({ commandIntentId: intent.id, workerId: result.instance.id, workerSessionGeneration: result.instance.workerSessionGeneration, bindingId: intent.context.primary.bindingId, bindingGeneration: intent.context.primary.bindingGeneration, rootMessageId: intent.context.rootMessageId });
        if (result.status === "created-start-failed") { outcomeCode = "created_start_failed"; outcomeDetail = result.error; }
        if (intent.idempotencyKey.startsWith("lark-message:")) await this.reply(message, `Worker ${result.instance.name} 已创建${result.status === "created-start-failed" ? `，但启动失败：${result.error}` : "。"}`);
      } else throw new Error(`Query command ${command.kind} cannot execute as mutation`);
      this.options.store.finishCommandIntent(intent.id, ok ? "succeeded" : "rejected", { code: ok ? outcomeCode : "rejected", detail: ok ? outcomeDetail : null, ...operation });
    } catch (error) {
      const detail = safeLogError(error).message;
      this.options.store.finishCommandIntent(intent.id, effectMayHaveStarted ? "uncertain" : "failed", { code: effectMayHaveStarted ? "external_effect_uncertain" : "failed", detail, ...operation });
      await this.reject(message, detail, intent.command.kind, "failed");
    }
  }

  private finish(intent: CommandIntent, state: "rejected", code: string, detail: string): void { this.options.store.finishCommandIntent(intent.id, state, { code, detail, operationKind: null, operationId: null }); }
  private async executeQuery(message: IncomingLarkMessage, command: BridgeCommand, binding: Binding | null): Promise<void> {
    if (command.kind === "help") return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-query:${message.messageId}:help`, this.options.presentation.help());
    if (command.kind === "projects") return this.options.provisioning.selectProject(message, null);
    if (command.kind === "spaces") return this.options.operationsQuery.listSpaces(message);
    if (command.kind === "panes") return this.options.operationsQuery.listTopicPanes(message, binding);
    if (command.kind === "sessions") return this.options.operationsQuery.listSessions(message);
    if (command.kind === "failures") return this.options.operationsQuery.listFailures(message);
    if (command.kind === "status" && binding) return this.options.sessionAdministration.emitStatus(binding);
    if (command.kind === "model") { await this.options.modelSelection.runModel(message, binding, null); return; }
    throw new Error(`Mutation command ${command.kind} cannot execute as query`);
  }
  private async awake(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!binding) return false; const result = await this.options.promptRun.awake(binding.id); const recovered = result.outcome === "recovered";
    const detail = recovered ? `已从 Herdr transcript 恢复 ${result.recoveredTurns} 个遗漏 turn；每个 turn 使用新的 Answer Card，未向 TraeX 重发任务。` : result.outcome === "busy" ? "当前绑定仍在切换观察器，请稍后重试 `/swarm awake`。" : result.reason === "no_detached_prompt" ? "当前没有 detached prompt，无需唤醒。" : result.reason === "no_complete_later_turn" ? "没有找到可安全恢复的完整后续 Herdr turn；原任务保持 detached，不会重发。" : `无法安全恢复（${result.reason}）；原任务保持 detached，不会重发。`;
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `awake:${message.messageId}`, this.options.presentation.awakeStatus(detail, recovered)); return recovered || result.outcome === "none";
  }
  private async reject(message: IncomingLarkMessage, reason: string, kind: string, outcome: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-rejected:${message.messageId}:${kind}`, this.options.presentation.requestRejected(reason)); this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${kind}`, target: message.messageId, outcome }); }
  private async reply(message: IncomingLarkMessage, text: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-result:${message.messageId}`, this.options.presentation.commandResult({ title: "Swarm command", text })); }
}

function messageFrom(intent: CommandIntent): IncomingLarkMessage { return { eventId: `command:${intent.id}`, messageId: intent.context.sourceMessageId, parentMessageId: null, chatId: intent.context.chatId, topicId: intent.context.topicId, rootMessageId: intent.context.rootMessageId, actorOpenId: intent.context.actorOpenId, text: "", mentionsBot: true, isRootMessage: false }; }
function sameFrozenPrimary(binding: Binding, primary: NonNullable<CommandIntent["context"]["primary"]>): boolean {
  const native = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
  return binding.generation === primary.bindingGeneration && binding.paneId === primary.paneId && binding.traexSessionId === primary.terminalId
    && JSON.stringify(native) === JSON.stringify(primary.nativeSession);
}
