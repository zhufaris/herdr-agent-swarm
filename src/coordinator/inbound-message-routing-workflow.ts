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
import type { SwarmCommandRuntime } from "./swarm-command-gateway.js";
import type { WorkerSessionThreadWorkflowPort } from "../domain/ports/worker-session-thread.js";
import type { NaturalLanguageCommandInterpreter } from "../domain/natural-language-command.js";
import type { NaturalLanguageCommandWorkflowPort } from "./natural-language-command-workflow.js";
import { isPromptInputTooLarge, MAX_PROMPT_INPUT_CHARS } from "../domain/prompt-input-policy.js";
import type { AgentInputRequest, AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import { InitialAgentInputWorkflow, type InitialAgentInputWorkflowPort } from "./initial-agent-input-workflow.js";
import { inputFromIncomingMessage } from "../domain/inbound.js";

export type InboundRoutingDisposition = "agent_input_accepted" | "prompt_queued" | "command_completed" | "user_feedback" | "rejected" | "deferred";
export interface InboundRoutingResult {
  decision: string;
  disposition: InboundRoutingDisposition;
  bindingId?: string;
  workspaceId?: string;
  paneId?: string | null;
  promptId?: string;
  submissionId?: string;
}
export interface InboundMessageRouterPort { route(message: IncomingLarkMessage): Promise<InboundRoutingResult>; }

interface Options {
  config: Pick<BridgeConfig, "lark" | "projects" | "defaultProjectId">;
  routing: Pick<InboundRoutingStore, "findBindingByLarkScope" | "isBindingThreadAlias">;
  agentInput: AgentInputWorkflowPort;
  initialAgentInput?: InitialAgentInputWorkflowPort;
  outbound: OutboundIntentPort;
  logger: Pick<Logger, "error">;
  presentation: Pick<PrimaryPresentation, "disconnectedTopic" | "requestRejected">;
  provisioning: BindingProvisioningWorkflowPort;
  swarmCommands: Pick<SwarmCommandRuntime, "submit">;
  instanceInteractions?: Pick<InstanceInteractionWorkflowPort, "handleCommand" | "handleOrdinaryMessage">;
  workerSessionThreads?: Pick<WorkerSessionThreadWorkflowPort, "handleMessage">;
  naturalLanguage?: { interpreter: NaturalLanguageCommandInterpreter; workflow: Pick<NaturalLanguageCommandWorkflowPort, "handle" | "requestSwarmConfirmation"> };
}

export class InboundMessageRoutingWorkflow implements InboundMessageRouterPort {
  private readonly initialAgentInput: InitialAgentInputWorkflowPort;

  constructor(private readonly options: Options) {
    this.initialAgentInput = options.initialAgentInput ?? new InitialAgentInputWorkflow({ agentInput: options.agentInput, outbound: options.outbound, presentation: options.presentation });
  }

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
    let submissionId: string | undefined;
    let resolvedBinding = binding;
    try {
      if (command && alias && rejectsAliasCommand(command)) {
        decision = `alias-command-rejected:${command.kind}`;
        await this.reject(message, "这个入口话题只用于当前 Agent 交互；请回到原始 Main Card 话题执行会话或拓扑管理命令。");
        disposition = "rejected";
      } else if (command) {
        decision = `command:${command.kind}`;
        const receipt = await this.options.swarmCommands.submit({ source: "literal", message, command });
        if (receipt.outcome === "rejected") { await this.reject(message, receipt.message); disposition = "rejected"; }
        else if (receipt.outcome === "conflict") { await this.reject(message, "命令幂等标识已用于不同请求。"); disposition = "rejected"; }
        else if (receipt.outcome === "confirmation-required") {
          if (!this.options.naturalLanguage) { await this.reject(message, "确认服务暂不可用。"); disposition = "rejected"; }
          else await this.options.naturalLanguage.workflow.requestSwarmConfirmation(message, command, receipt.context);
        }
      } else if (binding?.state === "active" && binding.lifecycle === "active") {
        const request = agentInputRequest(binding, message);
        if (request === null) {
          await this.reject(message, "当前 Agent 类型尚不支持从飞书提交输入；请在对应 Herdr Pane 中继续。");
          return result("agent-input-unsupported", "rejected", binding);
        }
        const submitted = await this.options.agentInput.submit(request);
        decision = "agent-input";
        if (submitted.outcome === "conflict" || submitted.state === "cancelled") {
          await this.reject(message, submitted.outcome === "conflict"
            ? "消息幂等标识已用于不同的 Agent 输入。"
            : "Agent 未接受这条输入；如需重试，请发送一条新消息。");
          disposition = "rejected";
        } else {
          disposition = "agent_input_accepted";
        }
        return { ...result(decision, disposition, binding), submissionId: submitted.submissionId };
      } else if (instanceCommand && alias) {
        decision = `alias-instance-command-rejected:${instanceCommand.kind}`;
        await this.reject(message, "这个入口话题固定连接当前 Pane 的 Primary Agent；请回到原始 Main Card 话题管理项目或 Worker。");
        disposition = "rejected";
      } else if (instanceCommand) {
        decision = `instance-command:${instanceCommand.kind}`;
        await this.options.instanceInteractions?.handleCommand(message, instanceCommand);
      } else if (message.text.trimStart().startsWith("/")) {
        decision = "unsupported-slash-command";
        await this.reject(message, "飞书仅支持已列出的 Swarm 命令；TraeX 原生命令请在对应 Herdr Pane 中执行。可使用 `/swarm help` 查看可用命令。");
        disposition = "rejected";
      } else if (this.isOrchestratorRoot(message)) {
        ({ decision, disposition, promptId, submissionId, binding: resolvedBinding } = await this.routeOrdinary(message, binding));
      } else if (message.mentionsBot && this.options.naturalLanguage) {
        const interpreted = await this.options.naturalLanguage.interpreter.interpret(message.text, message);
        if (interpreted.outcome === "unresolved") {
          decision = "natural-language:unresolved";
          await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `natural-language-unavailable:${message.messageId}`, this.options.presentation.requestRejected("暂时无法理解这条控制请求，请使用更明确的表达或 /swarm help。"));
          disposition = "user_feedback";
        } else if (interpreted.outcome !== "task") {
          decision = `natural-language:${interpreted.outcome === "command" ? `${interpreted.family}:${interpreted.command.kind}` : interpreted.outcome}`;
          await this.options.naturalLanguage.workflow.handle(message, interpreted);
        } else ({ decision, disposition, promptId, submissionId, binding: resolvedBinding } = await this.routeOrdinary(message, binding));
      } else ({ decision, disposition, promptId, submissionId, binding: resolvedBinding } = await this.routeOrdinary(message, binding));
    } catch (error) {
      const rejection = this.options.instanceInteractions ? permanentInstanceCommandRejection(error) : null;
      if (rejection) { await this.reject(message, rejection); return result(decision, "rejected", binding); }
      this.logFailure(error, message, binding);
      throw error;
    }
    return { ...result(decision, disposition, resolvedBinding, promptId), ...(submissionId ? { submissionId } : {}) };
  }

  private async routeOrdinary(message: IncomingLarkMessage, binding: Binding | null): Promise<Pick<InboundRoutingResult, "decision" | "disposition" | "promptId" | "submissionId"> & { binding: Binding | null }> {
    if (this.options.instanceInteractions && await this.options.instanceInteractions.handleOrdinaryMessage(message)) return { decision: "instance-prompt", disposition: "prompt_queued", binding };
    if (message.isRootMessage && message.mentionsBot && this.defaultOrchestratorEnabled()) {
      const ensured = await this.options.provisioning.ensureOrchestrator(message);
      if (!ensured) return { decision: "orchestrator_initialize", disposition: "rejected", binding: null };
      if (ensured.outcome === "initialized") {
        const admission = await this.initialAgentInput.submit(ensured.binding, ensured.selection);
        return initialAgentInputRouteResult("orchestrator_initialize", admission, ensured.binding);
      }
      await this.options.provisioning.shareOrchestratorThread(message, ensured.binding);
      return { decision: ensured.outcome === "existing" ? "orchestrator_entry" : "orchestrator_initializing", disposition: "user_feedback", binding: ensured.binding };
    }
    if (message.isRootMessage && message.mentionsBot && this.options.config.lark.adminOpenIds.includes(message.actorOpenId)) {
      const provisioned = await this.options.provisioning.provisionDefaultProject(message, deriveTopicTitle(message.text), message.text);
      if (!provisioned) return { decision: "create_binding", disposition: "rejected", binding: null };
      const admission = await this.initialAgentInput.submit(provisioned.binding, provisioned.selection);
      return initialAgentInputRouteResult("create_binding", admission, provisioned.binding);
    }
    if (message.isRootMessage && message.mentionsBot) {
      await this.reject(message, "你没有 Agent 管理权限。");
      return { decision: "create_binding_rejected", disposition: "rejected", binding };
    }
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, this.options.presentation.disconnectedTopic(binding?.state === "archived" ? "archived" : "unbound"));
    return { decision: binding?.state === "archived" ? "archived_feedback" : "unbound_feedback", disposition: "user_feedback", binding };
  }

  private defaultOrchestratorEnabled(): boolean {
    return this.options.config.projects.find((project) => project.id === this.options.config.defaultProjectId)?.orchestrator?.enabled === true;
  }

  private isOrchestratorRoot(message: IncomingLarkMessage): boolean {
    return message.isRootMessage && message.mentionsBot && this.defaultOrchestratorEnabled();
  }

  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> {
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason));
  }
  private logFailure(error: unknown, message: IncomingLarkMessage, binding?: Binding | null): void {
    this.options.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed");
  }
}

function agentInputRequest(binding: Binding, message: IncomingLarkMessage): AgentInputRequest | null {
  if (!binding.paneId || !binding.traexSessionId) throw new Error("Bound Primary Agent Input target is incomplete");
  if (binding.agentKind !== "traex" && binding.agentKind !== "pi") return null;
  const gatewayId = message.gatewayId ?? binding.gatewayId ?? "feishu:primary";
  const expectedSessionId = binding.agentSessionAgent === binding.agentKind
    ? binding.agentSessionValue ?? null
    : null;
  return {
    ingressSource: gatewayId,
    sourceMessageKey: message.messageId,
    actor: {
      kind: "human",
      id: message.actorOpenId,
      gatewayId,
      chatId: message.chatId,
      topicId: message.topicId,
      rootMessageId: message.rootMessageId
    },
    input: inputFromIncomingMessage(message),
    text: message.text,
    owner: { kind: "primary", id: binding.id, generation: binding.generation },
    paneId: binding.paneId,
    terminalId: binding.traexSessionId,
    expectedAgentKind: binding.agentKind,
    expectedSessionId
  };
}

function result(decision: string, disposition: InboundRoutingDisposition, binding?: Binding | null, promptId?: string): InboundRoutingResult {
  return { decision, disposition, ...(binding ? { bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId } : {}), ...(promptId ? { promptId } : {}) };
}
function initialAgentInputRouteResult(decision: string, admission: Awaited<ReturnType<InitialAgentInputWorkflowPort["submit"]>>, binding: Binding): Pick<InboundRoutingResult, "decision" | "disposition" | "submissionId"> & { binding: Binding } {
  if (admission.outcome === "accepted" || admission.outcome === "duplicate") return { decision, disposition: "agent_input_accepted", binding, submissionId: admission.submissionId };
  return { decision, disposition: admission.outcome === "skipped" ? "user_feedback" : "rejected", binding };
}
function permanentInstanceCommandRejection(error: unknown): string | null {
  if (isInstanceTurnCapacityExceeded(error)) return error.message;
  return isInstanceTargetError(error) ? error.message : null;
}
export function rejectsAliasCommand(command: BridgeCommand): boolean {
  return command.kind === "new" || command.kind === "projects" || command.kind === "spaces" || command.kind === "reset" || command.kind === "clear" || command.kind === "attach" || command.kind === "rename" || command.kind === "close" || command.kind === "pane_close_request" || command.kind === "pane_close_confirm" || command.kind === "reattach" || command.kind === "replace" || command.kind === "resume" || command.kind === "worker_create" || command.kind === "model" && command.name !== null;
}
