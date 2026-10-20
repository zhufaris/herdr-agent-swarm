import type { AgentInputRequest, AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { Binding, ProjectSelection } from "../domain/types.js";

export type InitialAgentInputResult =
  | { outcome: "accepted" | "duplicate"; submissionId: string }
  | { outcome: "rejected"; submissionId: string | null }
  | { outcome: "skipped"; submissionId: null };

export interface InitialAgentInputWorkflowPort {
  submit(binding: Binding, selection: ProjectSelection): Promise<InitialAgentInputResult>;
}

export class InitialAgentInputWorkflow implements InitialAgentInputWorkflowPort {
  constructor(private readonly options: {
    agentInput: AgentInputWorkflowPort;
    outbound: OutboundIntentPort;
    presentation: Pick<PrimaryPresentation, "requestRejected">;
  }) {}

  async submit(binding: Binding, selection: ProjectSelection): Promise<InitialAgentInputResult> {
    if (!selection.initialPromptText) return { outcome: "skipped", submissionId: null };
    const request = initialAgentInputRequest(binding, selection);
    if (!request) {
      await this.reject(binding, selection, "当前 Agent 类型尚不支持从飞书提交初始输入；请在对应 Herdr Pane 中继续。");
      return { outcome: "rejected", submissionId: null };
    }
    const submitted = await this.options.agentInput.submit(request);
    if (submitted.outcome === "conflict" || submitted.state === "cancelled") {
      await this.reject(binding, selection, submitted.outcome === "conflict"
        ? "初始消息幂等标识已用于不同的 Agent 输入。"
        : "Agent 未接受初始输入；如需重试，请发送一条新消息。");
      return { outcome: "rejected", submissionId: submitted.submissionId };
    }
    return { outcome: submitted.outcome, submissionId: submitted.submissionId };
  }

  private reject(binding: Binding, selection: ProjectSelection, reason: string): Promise<void> {
    return this.options.outbound.enqueueCard(binding.rootMessageId ?? selection.rootMessageId, `rejected:initial-agent-input:${selection.commandMessageId}`, this.options.presentation.requestRejected(reason));
  }
}

function initialAgentInputRequest(binding: Binding, selection: ProjectSelection): AgentInputRequest | null {
  if (!binding.paneId || !binding.traexSessionId) throw new Error("Provisioned Primary Agent Input target is incomplete");
  if (binding.agentKind !== "traex" && binding.agentKind !== "pi") return null;
  const gatewayId = binding.gatewayId ?? "feishu:primary";
  const expectedSessionId = binding.agentSessionAgent === binding.agentKind
    ? binding.agentSessionValue ?? null
    : null;
  return {
    ingressSource: gatewayId,
    sourceMessageKey: selection.commandMessageId,
    actor: {
      kind: "human",
      id: selection.actorOpenId,
      gatewayId,
      chatId: selection.chatId,
      topicId: selection.topicId,
      rootMessageId: selection.rootMessageId
    },
    text: selection.initialPromptText!,
    owner: { kind: "primary", id: binding.id, generation: binding.generation },
    paneId: binding.paneId,
    terminalId: binding.traexSessionId,
    expectedAgentKind: binding.agentKind,
    expectedSessionId
  };
}
