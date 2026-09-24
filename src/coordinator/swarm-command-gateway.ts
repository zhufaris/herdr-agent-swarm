import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CreateWorkerResult } from "../domain/agent-instance.js";
import type { CommandIntent } from "../domain/command-intent.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { InstanceControlPort } from "../domain/ports/instance-workflows.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CommandIntentWorkflowStore } from "../domain/ports/swarm-command.js";
import { swarmCommandPolicy } from "../domain/swarm-command.js";
import type { BridgeCommand, Binding, IncomingLarkCardAction, IncomingLarkMessage } from "../domain/types.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import { CommandIntentDispatcher } from "./command-intent-dispatcher.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { OperationsQueryWorkflowPort } from "./operations-query-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import { SwarmCommandContextResolver, type SwarmCommandContextResolution } from "./swarm-command-context-resolver.js";

interface Options {
  store: CommandIntentWorkflowStore; primaryPrompts: Pick<InstanceStore, "getActiveOrdinaryPrompt">;
  resolver: SwarmCommandContextResolver; outbound: Pick<OutboundIntentPort, "enqueueCard">; logger: Logger;
  provisioning: BindingProvisioningWorkflowPort; modelSelection: ModelSelectionWorkflowPort; paneControl: PaneControlWorkflowPort;
  operationsQuery: OperationsQueryWorkflowPort; sessionAdministration: SessionAdministrationWorkflowPort; paneClosure: PaneClosureWorkflowPort;
  promptRun: PromptRunWorkflowPort; instanceControl: Pick<InstanceControlPort, "createWorker" | "inspect">;
  wakeCardContext(): void;
  wakeOutbound?(): void;
  wakeCommand?(intentId: string): void;
  presentation: Pick<ApplicationPresentation, "help" | "awakeStatus" | "skipStatus" | "requestRejected" | "commandResult" | "commandStatus">;
}

type WorkerCreateCommand = Extract<BridgeCommand, { kind: "worker_create" }>;
type PrimaryToolCommandRequest = {
  source: "primary-tool"; bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: WorkerCreateCommand;
};
export type SwarmCommandRequest =
  | { source: "literal"; message: IncomingLarkMessage; command: BridgeCommand }
  | { source: "natural-language"; message: IncomingLarkMessage; command: BridgeCommand }
  | { source: "card"; action: IncomingLarkCardAction; bindingId: string; command: WorkerCreateCommand }
  | PrimaryToolCommandRequest;
export type SwarmCommandReceipt =
  | { outcome: "query-completed"; commandKind: BridgeCommand["kind"] }
  | { outcome: "accepted"; commandKind: BridgeCommand["kind"]; intent: CommandIntent; workerResult?: CreateWorkerResult }
  | { outcome: "rejected"; commandKind: BridgeCommand["kind"]; code: string; message: string }
  | { outcome: "conflict"; commandKind: BridgeCommand["kind"]; intent: CommandIntent };

export interface SwarmCommandGatewayPort {
  submit(request: SwarmCommandRequest): Promise<SwarmCommandReceipt>;
  handle(message: IncomingLarkMessage, command: BridgeCommand): Promise<void>;
  resolve(message: IncomingLarkMessage, command: BridgeCommand): SwarmCommandContextResolution;
  drainAcceptedIntent(intent: CommandIntent): Promise<void>;
  wakeAcceptedIntent(intent: Pick<CommandIntent, "id">): void;
  start(intervalMs: number): void;
  createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult>;
  createWorkerFromPrimaryTool(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: Extract<BridgeCommand, { kind: "worker_create" }> }): Promise<CreateWorkerResult>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

export class SwarmCommandGateway implements SwarmCommandGatewayPort {
  private readonly dispatcher: CommandIntentDispatcher;
  private accepting = true;
  constructor(private readonly options: Options) { this.dispatcher = new CommandIntentDispatcher(options); }

  resolve(message: IncomingLarkMessage, command: BridgeCommand): SwarmCommandContextResolution { return this.options.resolver.resolve(message, command); }
  async drainAcceptedIntent(intent: CommandIntent): Promise<void> { await this.dispatcher.drain(intent); }
  wakeAcceptedIntent(intent: Pick<CommandIntent, "id">): void { this.dispatcher.wake(intent.id); }
  start(intervalMs: number): void { this.dispatcher.start(intervalMs); }

  async handle(message: IncomingLarkMessage, command: BridgeCommand): Promise<void> {
    const receipt = await this.submit({ source: "literal", message, command });
    if (receipt.outcome === "rejected") await this.reject(message, receipt.message, command.kind, receipt.code);
    else if (receipt.outcome === "conflict") await this.reject(message, "命令幂等标识已用于不同请求。", command.kind, "idempotency_conflict");
  }

  async submit(request: SwarmCommandRequest): Promise<SwarmCommandReceipt> {
    const normalized = this.normalize(request);
    if (normalized.outcome === "rejected") return { outcome: "rejected", commandKind: request.command.kind, code: normalized.code, message: normalized.message };
    const { message, command, resolved, idempotencyKey } = normalized;
    const policy = swarmCommandPolicy(command);
    if (policy.mode === "query") {
      await this.executeQuery(message, command, resolved.binding);
      this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${command.kind}`, target: resolved.laneKey, outcome: "success" });
      return { outcome: "query-completed", commandKind: command.kind };
    }
    if (!this.accepting) return { outcome: "rejected", commandKind: command.kind, code: "shutting_down", message: "Swarm command admission is stopping" };
    const accepted = this.options.store.acceptCommandIntent({ id: randomUUID(), idempotencyKey, laneKey: resolved.laneKey, command, context: resolved.context, replayPolicy: policy.replay as Exclude<typeof policy.replay, "none">, acceptedAt: new Date().toISOString() }, request.source, this.options.presentation.commandStatus);
    if (accepted.outcome === "conflict") return { outcome: "conflict", commandKind: command.kind, intent: accepted.intent };
    this.options.wakeOutbound?.();
    if (this.options.wakeCommand) this.options.wakeCommand(accepted.intent.id);
    else this.dispatcher.wake(accepted.intent.id);
    const workerResult = command.kind === "worker_create" && (request.source === "card" || request.source === "primary-tool")
      ? await this.dispatcher.resultForWorkerCreate(accepted.intent.id, accepted.intent.laneKey)
      : undefined;
    return { outcome: "accepted", commandKind: command.kind, intent: this.options.store.getCommandIntent(accepted.intent.id) ?? accepted.intent, ...(workerResult ? { workerResult } : {}) };
  }

  async createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult> {
    const receipt = await this.submit({ source: "card", action, bindingId, command });
    if (receipt.outcome !== "accepted") throw new Error(receipt.outcome === "rejected" ? receipt.message : "命令幂等标识已用于不同请求。");
    if (!receipt.workerResult) throw new Error("Worker creation did not complete");
    return receipt.workerResult;
  }

  async createWorkerFromPrimaryTool(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: Extract<BridgeCommand, { kind: "worker_create" }> }): Promise<CreateWorkerResult> {
    const receipt = await this.submit({ source: "primary-tool", ...input });
    if (receipt.outcome !== "accepted") throw new Error(receipt.outcome === "rejected" ? receipt.message : "Idempotency key was already used for a different Worker creation request");
    if (!receipt.workerResult) throw new Error("Worker creation did not complete");
    return receipt.workerResult;
  }

  recover(): Promise<void> { return this.dispatcher.recover(); }
  stop(): Promise<void> { this.accepting = false; return this.dispatcher.stop(); }

  private async executeQuery(message: IncomingLarkMessage, command: BridgeCommand, binding: Binding | null): Promise<void> {
    if (command.kind === "help") return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-query:${message.messageId}:help`, this.options.presentation.help());
    if (command.kind === "projects") return this.options.provisioning.selectProject(message, null);
    if (command.kind === "spaces") return this.options.operationsQuery.listSpaces(message);
    if (command.kind === "panes") return this.options.operationsQuery.listTopicPanes(message, binding);
    if (command.kind === "sessions") return this.options.operationsQuery.listSessions(message, command.cursor);
    if (command.kind === "failures") return this.options.operationsQuery.listFailures(message);
    if (command.kind === "status" && binding) return this.options.sessionAdministration.emitStatus(binding);
    if (command.kind === "model") { await this.options.modelSelection.runModel(message, binding, null); return; }
    throw new Error(`Mutation command ${command.kind} cannot execute as query`);
  }
  private normalize(request: SwarmCommandRequest): { outcome: "resolved"; message: IncomingLarkMessage; command: BridgeCommand; resolved: Extract<SwarmCommandContextResolution, { outcome: "resolved" }>; idempotencyKey: string } | Extract<SwarmCommandContextResolution, { outcome: "rejected" }> {
    if (request.source === "literal" || request.source === "natural-language") {
      const resolved = this.options.resolver.resolve(request.message, request.command);
      if (resolved.outcome === "rejected") return resolved;
      const prefix = request.source === "literal" ? "lark-message" : "natural-language";
      return { outcome: "resolved", message: request.message, command: request.command, resolved, idempotencyKey: `${prefix}:${request.message.messageId}:${request.command.kind}` };
    }
    if (request.source === "card") {
      const binding = this.options.store.getBinding(request.bindingId);
      const message: IncomingLarkMessage = { eventId: `card:${request.action.messageId}`, messageId: request.action.messageId, parentMessageId: null, chatId: request.action.chatId, topicId: binding?.topicId ?? null, rootMessageId: binding?.rootMessageId ?? request.action.messageId, actorOpenId: request.action.operatorOpenId, text: "/swarm worker create", mentionsBot: true, isRootMessage: false };
      const resolved = this.options.resolver.resolve(message, request.command, request.bindingId);
      if (resolved.outcome === "rejected") return resolved;
      const fingerprint = createHash("sha256").update(JSON.stringify(request.command)).digest("hex");
      return { outcome: "resolved", message, command: request.command, resolved, idempotencyKey: `lark-card:${request.action.messageId}:worker-create:${request.action.operatorOpenId}:${fingerprint}` };
    }
    const binding = this.options.store.getBinding(request.bindingId);
    if (!binding || binding.generation !== request.bindingGeneration || binding.rootMessageId !== request.rootMessageId) return { outcome: "rejected", code: "binding_required", message: "Primary tool context is stale" };
    const prompt = this.options.primaryPrompts.getActiveOrdinaryPrompt(request.bindingId, request.bindingGeneration);
    if (!prompt || prompt.id !== request.parentPromptId || prompt.larkMessageId !== request.sourceMessageId) return { outcome: "rejected", code: "binding_required", message: "Primary tool active prompt changed" };
    const message: IncomingLarkMessage = { eventId: `primary-tool:${request.parentPromptId}:${request.idempotencyKey}`, messageId: request.sourceMessageId, parentMessageId: null, chatId: binding.chatId, topicId: binding.topicId, rootMessageId: request.rootMessageId, actorOpenId: prompt.actorOpenId, text: "Primary tool worker create", mentionsBot: true, isRootMessage: false };
    const resolved = this.options.resolver.resolve(message, request.command, request.bindingId);
    if (resolved.outcome === "rejected") return resolved;
    const context = { ...resolved.context, primary: { ...resolved.context.primary!, activePromptId: request.parentPromptId } };
    return { outcome: "resolved", message, command: request.command, resolved: { ...resolved, context }, idempotencyKey: `primary-tool:${request.bindingId}:${request.bindingGeneration}:${request.parentPromptId}:${request.idempotencyKey}` };
  }
  private async reject(message: IncomingLarkMessage, reason: string, kind: string, outcome: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-rejected:${message.messageId}:${kind}`, this.options.presentation.requestRejected(reason)); this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${kind}`, target: message.messageId, outcome }); }
}
