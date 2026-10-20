import { randomUUID } from "node:crypto";
import type { FrozenCommandTarget, NaturalLanguageCommandConfirmation } from "../domain/natural-language-command-confirmation.js";
import type { NaturalLanguageCommandResult } from "../domain/natural-language-command.js";
import type { NaturalLanguageCommandConfirmationStore } from "../domain/ports/natural-language-command-confirmation.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { swarmCommandPolicy, type SwarmCommandContext } from "../domain/swarm-command.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, InstanceCommand, LarkCardActionResult } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { InstanceInteractionWorkflowPort } from "./instance-interaction-workflow.js";
import type { SwarmCommandRuntime } from "./swarm-command-gateway.js";

interface Options {
  store: NaturalLanguageCommandConfirmationStore; outbound: Pick<OutboundIntentPort, "enqueueCard">; outboundWork: OutboundWorkNotifier;
  presentation: Pick<ApplicationPresentation, "naturalLanguageCommandConfirmation" | "naturalLanguageCommandGuidance" | "requestRejected" | "commandStatus">;
  swarmCommands: Pick<SwarmCommandRuntime, "submit" | "resolve" | "wakeAcceptedIntent">; instanceInteractions?: Pick<InstanceInteractionWorkflowPort, "handleCommand" | "resolveNaturalLanguageMutationTarget">; confirmationTtlMs?: number; now?: () => Date; idFactory?: () => string;
}

export interface NaturalLanguageCommandWorkflowPort {
  handle(message: IncomingLarkMessage, result: Exclude<NaturalLanguageCommandResult, { outcome: "task" | "unresolved" }>): Promise<void>;
  requestSwarmConfirmation(message: IncomingLarkMessage, command: import("../domain/types.js").BridgeCommand, context: SwarmCommandContext): Promise<void>;
  decide(action: IncomingLarkCardAction, confirmationId: string, decision: "confirm" | "cancel"): Promise<LarkCardActionResult>;
}

export class NaturalLanguageCommandWorkflow implements NaturalLanguageCommandWorkflowPort {
  constructor(private readonly options: Options) {}

  async handle(message: IncomingLarkMessage, result: Exclude<NaturalLanguageCommandResult, { outcome: "task" | "unresolved" }>): Promise<void> {
    if (result.outcome === "clarification" || result.outcome === "unsupported") {
      await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `natural-language-guidance:${message.messageId}`, this.options.presentation.naturalLanguageCommandGuidance({ title: result.outcome === "unsupported" ? "不支持的 Swarm 操作" : "需要补充信息", message: result.message, examples: result.examples, warning: true }));
      return;
    }
    let swarmContext: SwarmCommandContext | null = null;
    if (result.family === "swarm") {
      const receipt = await this.options.swarmCommands.submit({ source: "natural-language", message, command: result.command });
      if (receipt.outcome === "query-completed" || receipt.outcome === "accepted") return;
      if (receipt.outcome === "rejected") { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `natural-language-rejected:${message.messageId}`, this.options.presentation.requestRejected(receipt.message)); return; }
      if (receipt.outcome === "conflict") throw new Error(`Natural-language command conflict: ${message.messageId}`);
      swarmContext = receipt.context;
    }
    if (result.family === "instance" && isInstanceQuery(result.command)) return this.options.instanceInteractions?.handleCommand(message, result.command);
    const frozen = swarmContext ? frozenSwarmContext(swarmContext) : this.freeze(message, result);
    if (frozen.outcome === "rejected") {
      await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `natural-language-rejected:${message.messageId}`, this.options.presentation.requestRejected(frozen.message));
      return;
    }
    await this.stage(message, result.family, result.command, frozen.target);
  }

  async requestSwarmConfirmation(message: IncomingLarkMessage, command: import("../domain/types.js").BridgeCommand, context: SwarmCommandContext): Promise<void> {
    await this.stage(message, "swarm", command, frozenSwarmContext(context).target);
  }

  private async stage(message: IncomingLarkMessage, family: "swarm" | "instance", command: import("../domain/types.js").BridgeCommand | InstanceCommand, target: FrozenCommandTarget): Promise<void> {
    const createdAt = (this.options.now ?? (() => new Date()))();
    const id = (this.options.idFactory ?? randomUUID)();
    const confirmation: NaturalLanguageCommandConfirmation & { frozenTarget: FrozenCommandTarget } = {
      id, sourceMessageId: message.messageId, actorOpenId: message.actorOpenId, chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId ?? message.messageId,
      envelope: { version: 1, family, command } as NaturalLanguageCommandConfirmation["envelope"],
      frozenTarget: target,
      state: "pending", expiresAt: new Date(createdAt.getTime() + (this.options.confirmationTtlMs ?? 10 * 60_000)).toISOString(), resultDetail: null, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), resolvedAt: null
    };
    const staged = this.options.store.stageNaturalLanguageCommandConfirmation({ confirmation, outbox: { id: randomUUID(), idempotencyKey: `natural-language-confirmation:${id}`, card: this.options.presentation.naturalLanguageCommandConfirmation(confirmation) } });
    if (staged.outcome === "conflict") throw new Error(`Natural-language source message conflict: ${message.messageId}`);
    this.options.outboundWork.wake();
  }

  async decide(action: IncomingLarkCardAction, confirmationId: string, decision: "confirm" | "cancel"): Promise<LarkCardActionResult> {
    const decidedAt = (this.options.now ?? (() => new Date()))().toISOString();
    if (decision === "cancel") {
      const result = this.options.store.decideNaturalLanguageCommandConfirmation({ id: confirmationId, decision, actorOpenId: action.operatorOpenId, chatId: action.chatId, decidedAt });
      if (result.outcome === "unauthorized") return { toast: { type: "error", content: "只有原请求人可以确认或取消。" } };
      if (result.outcome !== "cancelled") return stale();
      return { toast: { type: "success", content: "已取消，不会执行命令。" } };
    }
    const current = this.options.store.getNaturalLanguageCommandConfirmation(confirmationId);
    if (!current) {
      this.options.store.decideNaturalLanguageCommandConfirmation({ id: confirmationId, decision: "confirm", actorOpenId: action.operatorOpenId, chatId: action.chatId, decidedAt });
      return stale();
    }
    if (decision === "confirm" && current.envelope.family === "swarm") {
      const message = syntheticMessage(current, action.operatorOpenId);
      const resolution = this.options.swarmCommands.resolve(message, current.envelope.command);
      if (resolution.outcome === "rejected") return { toast: { type: "error", content: resolution.message } };
      const policy = swarmCommandPolicy(current.envelope.command);
      if (policy.mode !== "mutation" || policy.replay === "none") return stale();
      const accepted = this.options.store.confirmNaturalLanguageSwarmCommand({
        id: confirmationId, actorOpenId: action.operatorOpenId, chatId: action.chatId, decidedAt,
        resolvedTarget: resolution.target,
        commandIntent: { id: randomUUID(), idempotencyKey: `natural-language-confirmation:${confirmationId}:${current.envelope.command.kind}`, laneKey: resolution.laneKey, command: current.envelope.command, context: resolution.context, replayPolicy: policy.replay, acceptedAt: decidedAt },
        renderStatus: this.options.presentation.commandStatus
      });
      if (accepted.outcome === "unauthorized") return { toast: { type: "error", content: "只有原请求人可以确认或取消。" } };
      if (accepted.outcome !== "consumed") return stale();
      this.options.outboundWork.wake();
      this.options.swarmCommands.wakeAcceptedIntent(accepted.commandIntent.intent);
      return { toast: { type: "success", content: "已确认，命令已提交。" } };
    }
    if (decision === "confirm" && current.envelope.family === "instance") {
      if (isInstanceQuery(current.envelope.command) || !this.options.instanceInteractions) return stale();
      const resolution = this.options.instanceInteractions.resolveNaturalLanguageMutationTarget(syntheticMessage(current, action.operatorOpenId), current.envelope.command);
      if (resolution.outcome === "rejected") return { toast: { type: "error", content: resolution.message } };
      const result = this.options.store.decideNaturalLanguageCommandConfirmation({ id: confirmationId, decision, actorOpenId: action.operatorOpenId, chatId: action.chatId, decidedAt, resolvedTarget: resolution.target });
      if (result.outcome === "unauthorized") return { toast: { type: "error", content: "只有原请求人可以确认或取消。" } };
      if (result.outcome !== "consumed") return stale();
      await this.execute(result.confirmation);
      return { toast: { type: "success", content: "已确认，命令已提交。" } };
    }
    return stale();
  }

  private freeze(message: IncomingLarkMessage, result: Extract<NaturalLanguageCommandResult, { outcome: "command" }>): { outcome: "resolved"; target: FrozenCommandTarget } | { outcome: "rejected"; message: string } {
    if (result.family === "swarm") {
      const resolution = this.options.swarmCommands.resolve(message, result.command);
      return resolution.outcome === "rejected" ? resolution : { outcome: "resolved", target: resolution.target };
    }
    if (!this.options.instanceInteractions || isInstanceQuery(result.command)) return { outcome: "rejected", message: "Agent 控制功能不可用。" };
    const resolution = this.options.instanceInteractions.resolveNaturalLanguageMutationTarget(message, result.command);
    return resolution.outcome === "rejected" ? resolution : { outcome: "resolved", target: resolution.target };
  }

  private async execute(value: NaturalLanguageCommandConfirmation): Promise<void> {
    const message = syntheticMessage(value, value.actorOpenId);
    if (value.envelope.family === "instance") await this.options.instanceInteractions?.handleCommand(message, value.envelope.command);
  }
}

function syntheticMessage(value: NaturalLanguageCommandConfirmation, actorOpenId: string): IncomingLarkMessage { return { eventId: `natural-language-confirmation:${value.id}`, messageId: `natural-language-confirmation:${value.id}`, parentMessageId: null, chatId: value.chatId, topicId: value.topicId, rootMessageId: value.rootMessageId, actorOpenId, text: "", mentionsBot: true, isRootMessage: false }; }
function frozenSwarmContext(context: SwarmCommandContext): { outcome: "resolved"; target: FrozenCommandTarget } {
  return { outcome: "resolved", target: { version: 1, kind: "swarm", bindingId: context.primary?.bindingId ?? null, bindingGeneration: context.primary?.bindingGeneration ?? null, paneId: context.primary?.paneId ?? null, terminalId: context.primary?.terminalId ?? null, nativeSession: context.primary?.nativeSession ?? null, activePromptId: context.primary?.activePromptId ?? null } };
}
function isInstanceQuery(command: InstanceCommand): command is Extract<InstanceCommand, { kind: "projects" | "project" | "instances" | "instance" }> { return command.kind === "projects" || command.kind === "project" || command.kind === "instances" || command.kind === "instance"; }
function stale(): LarkCardActionResult { return { toast: { type: "warning", content: "该确认已失效，请重新发送请求。" } }; }
