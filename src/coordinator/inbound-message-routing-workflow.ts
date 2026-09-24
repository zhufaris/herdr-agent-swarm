import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand, parseInstanceCommand } from "../domain/commands.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import type { Binding, BridgeCommand, IncomingLarkMessage } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { isInstanceTurnCapacityExceeded } from "../domain/instance-turn-capacity-error.js";
import { isInstanceTargetError } from "../domain/instance-target-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { InstanceInteractionWorkflowPort } from "./instance-interaction-workflow.js";
import type { SwarmCommandGatewayPort } from "./swarm-command-gateway.js";
import type { WorkerSessionThreadWorkflowPort } from "../domain/ports/worker-session-thread.js";
import type { NaturalLanguageCommandInterpreter } from "../domain/natural-language-command.js";
import type { NaturalLanguageCommandWorkflowPort } from "./natural-language-command-workflow.js";
import { isPromptInputTooLarge, MAX_PROMPT_INPUT_CHARS } from "../domain/prompt-input-policy.js";
import type { PromptAdmissionWorkflowPort } from "./prompt-admission-workflow.js";

export type InboundRoutingDisposition = "prompt_queued" | "command_completed" | "user_feedback" | "rejected";
export interface InboundRoutingResult {
  decision: string;
  disposition: InboundRoutingDisposition;
  bindingId?: string;
  workspaceId?: string;
  paneId?: string | null;
  promptId?: string;
}
export interface InboundMessageRouterPort { route(message: IncomingLarkMessage): Promise<InboundRoutingResult>; }

interface Options {
  config: Pick<BridgeConfig, "lark">;
  routing: Pick<InboundRoutingStore, "findBindingByLarkScope" | "isBindingThreadAlias">;
  promptAdmission: PromptAdmissionWorkflowPort;
  outbound: OutboundIntentPort;
  logger: Pick<Logger, "error">;
  presentation: Pick<PrimaryPresentation, "disconnectedTopic" | "requestRejected">;
  provisioning: BindingProvisioningWorkflowPort;
  swarmCommands: SwarmCommandGatewayPort;
  instanceInteractions?: Pick<InstanceInteractionWorkflowPort, "handleCommand" | "handleOrdinaryMessage">;
  workerSessionThreads?: Pick<WorkerSessionThreadWorkflowPort, "handleMessage">;
  naturalLanguage?: { interpreter: NaturalLanguageCommandInterpreter; workflow: Pick<NaturalLanguageCommandWorkflowPort, "handle"> };
}

export class InboundMessageRoutingWorkflow implements InboundMessageRouterPort {
  constructor(private readonly options: Options) {}

  async route(message: IncomingLarkMessage): Promise<InboundRoutingResult> {
    if (message.inputTooLarge || isPromptInputTooLarge(message.text)) {
      const rejection = `消息过长，请控制在 ${MAX_PROMPT_INPUT_CHARS} 个字符和 32 KiB 以内。`;
      await this.reject(message, rejection);
      return { decision: "input-too-large", disposition: "rejected" };
    }
    if (this.options.workerSessionThreads) {
      try {
        const workerRoute = await this.options.workerSessionThreads.handleMessage(message);
        if (workerRoute.handled) return { decision: "worker-session-thread", disposition: workerRoute.disposition };
      } catch (error) {
        const rejection = permanentInstanceCommandRejection(error);
        if (rejection) { await this.reject(message, rejection); return { decision: "worker-session-thread", disposition: "rejected" }; }
        this.logFailure(error, message);
        throw error;
      }
    }

    const instanceCommand = parseInstanceCommand(message.text);
    const command = parseCommand(message.text);
    const binding = this.options.routing.findBindingByLarkScope(message.topicId, message.rootMessageId);
    const alias = this.options.routing.isBindingThreadAlias(message.topicId, message.rootMessageId);
    let decision = "unresolved";
    let disposition: InboundRoutingDisposition = "command_completed";
    let promptId: string | undefined;
    try {
      if (instanceCommand && alias) {
        decision = `alias-instance-command-rejected:${instanceCommand.kind}`;
        await this.reject(message, "这个入口话题固定连接当前 Pane 的 Primary Agent；请回到原始 Main Card 话题管理项目或 Worker。");
        disposition = "rejected";
      } else if (instanceCommand) {
        decision = `instance-command:${instanceCommand.kind}`;
        await this.options.instanceInteractions?.handleCommand(message, instanceCommand);
      } else if (command && alias && rejectsAliasCommand(command)) {
        decision = `alias-command-rejected:${command.kind}`;
        await this.reject(message, "这个入口话题只用于当前 Agent 交互；请回到原始 Main Card 话题执行会话或拓扑管理命令。");
        disposition = "rejected";
      } else if (command) {
        decision = `command:${command.kind}`;
        await this.options.swarmCommands.handle(message, command);
      } else if (message.mentionsBot && this.options.naturalLanguage) {
        const interpreted = await this.options.naturalLanguage.interpreter.interpret(message.text, message);
        if (interpreted.outcome === "unresolved") {
          decision = "natural-language:unresolved";
          await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `natural-language-unavailable:${message.messageId}`, this.options.presentation.requestRejected("暂时无法理解这条控制请求，请使用更明确的表达或 /swarm help。"));
          disposition = "user_feedback";
        } else if (interpreted.outcome !== "task") {
          decision = `natural-language:${interpreted.outcome === "command" ? `${interpreted.family}:${interpreted.command.kind}` : interpreted.outcome}`;
          await this.options.naturalLanguage.workflow.handle(message, interpreted);
        } else ({ decision, disposition, promptId } = await this.routeOrdinary(message, binding));
      } else ({ decision, disposition, promptId } = await this.routeOrdinary(message, binding));
    } catch (error) {
      const rejection = this.options.instanceInteractions ? permanentInstanceCommandRejection(error) : null;
      if (rejection) { await this.reject(message, rejection); return result(decision, "rejected", binding); }
      this.logFailure(error, message, binding);
      throw error;
    }
    return result(decision, disposition, binding, promptId);
  }

  private async routeOrdinary(message: IncomingLarkMessage, binding: Binding | null): Promise<Pick<InboundRoutingResult, "decision" | "disposition" | "promptId">> {
    if (binding?.state === "active" && binding.lifecycle === "active") {
      const accepted = await this.options.promptAdmission.accept(binding, message);
      return { decision: "prompt", disposition: accepted ? "prompt_queued" : "rejected", ...(accepted ? { promptId: accepted.promptId } : {}) };
    }
    if (this.options.instanceInteractions && await this.options.instanceInteractions.handleOrdinaryMessage(message)) return { decision: "instance-prompt", disposition: "prompt_queued" };
    if (message.isRootMessage && message.mentionsBot && this.options.config.lark.adminOpenIds.includes(message.actorOpenId)) {
      const provisioned = await this.options.provisioning.provisionDefaultProject(message, deriveTopicTitle(message.text), message.text);
      if (!provisioned) return { decision: "create_binding", disposition: "rejected" };
      const accepted = await this.options.promptAdmission.acceptInitial(provisioned.binding, provisioned.selection);
      return { decision: "create_binding", disposition: accepted ? "prompt_queued" : "rejected", ...(accepted ? { promptId: accepted.promptId } : {}) };
    }
    if (message.isRootMessage && message.mentionsBot) {
      await this.reject(message, "你没有 Agent 管理权限。");
      return { decision: "create_binding_rejected", disposition: "rejected" };
    }
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, this.options.presentation.disconnectedTopic(binding?.state === "archived" ? "archived" : "unbound"));
    return { decision: binding?.state === "archived" ? "archived_feedback" : "unbound_feedback", disposition: "user_feedback" };
  }

  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> {
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason));
  }
  private logFailure(error: unknown, message: IncomingLarkMessage, binding?: Binding | null): void {
    this.options.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed");
  }
}

function result(decision: string, disposition: InboundRoutingDisposition, binding?: Binding | null, promptId?: string): InboundRoutingResult {
  return { decision, disposition, ...(binding ? { bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId } : {}), ...(promptId ? { promptId } : {}) };
}
function permanentInstanceCommandRejection(error: unknown): string | null {
  if (isInstanceTurnCapacityExceeded(error)) return error.message;
  return isInstanceTargetError(error) ? error.message : null;
}
export function rejectsAliasCommand(command: BridgeCommand): boolean {
  return command.kind === "new" || command.kind === "projects" || command.kind === "spaces" || command.kind === "reset" || command.kind === "attach" || command.kind === "rename" || command.kind === "close" || command.kind === "pane_close_request" || command.kind === "pane_close_confirm" || command.kind === "reattach" || command.kind === "replace" || command.kind === "resume" || command.kind === "worker_create" || command.kind === "model" && command.name !== null;
}
