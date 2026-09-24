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
  presentation: Pick<ApplicationPresentation, "help" | "awakeStatus" | "skipStatus" | "requestRejected" | "commandResult">;
}

export interface SwarmCommandGatewayPort {
  handle(message: IncomingLarkMessage, command: BridgeCommand): Promise<void>;
  resolve(message: IncomingLarkMessage, command: BridgeCommand): SwarmCommandContextResolution;
  drainAcceptedIntent(intent: CommandIntent): Promise<void>;
  createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult>;
  createWorkerFromPrimaryTool(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string; idempotencyKey: string; command: Extract<BridgeCommand, { kind: "worker_create" }> }): Promise<CreateWorkerResult>;
  recover(): Promise<void>;
  stop(): Promise<void>;
}

export class SwarmCommandGateway implements SwarmCommandGatewayPort {
  private readonly dispatcher: CommandIntentDispatcher;
  constructor(private readonly options: Options) { this.dispatcher = new CommandIntentDispatcher(options); }

  resolve(message: IncomingLarkMessage, command: BridgeCommand): SwarmCommandContextResolution { return this.options.resolver.resolve(message, command); }
  async drainAcceptedIntent(intent: CommandIntent): Promise<void> { await this.dispatcher.drain(intent); }

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
    await this.dispatcher.drain(accepted.intent);
  }

  async createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: Extract<BridgeCommand, { kind: "worker_create" }>): Promise<CreateWorkerResult> {
    const binding = this.options.store.getBinding(bindingId);
    const message: IncomingLarkMessage = { eventId: `card:${action.messageId}`, messageId: action.messageId, parentMessageId: null, chatId: action.chatId, topicId: binding?.topicId ?? null, rootMessageId: binding?.rootMessageId ?? action.messageId, actorOpenId: action.operatorOpenId, text: "/swarm worker create", mentionsBot: true, isRootMessage: false };
    const resolved = this.options.resolver.resolve(message, command, bindingId);
    if (resolved.outcome === "rejected") throw new Error(resolved.message);
    const requestFingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const accepted = this.options.store.acceptCommandIntent({ id: randomUUID(), idempotencyKey: `lark-card:${action.messageId}:worker-create:${action.operatorOpenId}:${requestFingerprint}`, laneKey: resolved.laneKey, command, context: resolved.context, replayPolicy: "reconcilable", acceptedAt: new Date().toISOString() });
    if (accepted.outcome === "conflict") throw new Error("命令幂等标识已用于不同请求。");
    return this.dispatcher.resultForWorkerCreate(accepted.intent.id, accepted.intent.laneKey);
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
    return this.dispatcher.resultForWorkerCreate(accepted.intent.id, accepted.intent.laneKey);
  }

  recover(): Promise<void> { return this.dispatcher.recover(); }
  stop(): Promise<void> { return this.dispatcher.stop(); }

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
  private async reject(message: IncomingLarkMessage, reason: string, kind: string, outcome: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `swarm-rejected:${message.messageId}:${kind}`, this.options.presentation.requestRejected(reason)); this.options.store.audit({ actorOpenId: message.actorOpenId, action: `swarm.${kind}`, target: message.messageId, outcome }); }
}
