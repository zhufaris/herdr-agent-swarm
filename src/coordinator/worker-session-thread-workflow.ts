import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../domain/inbound.js";
import type { GatewayEffectPort } from "../gateways/effect-client.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { WorkerSessionThreadApplicationStore, WorkerSessionThreadWorkflowPort, WorkerThreadPublicationTarget, WorkerThreadResolution } from "../domain/ports/worker-session-thread.js";
import type { InstanceMessagingPort } from "../domain/ports/instance-workflows.js";
import type { AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { HerdrPort } from "../domain/ports/external.js";

export class WorkerSessionThreadWorkflow implements WorkerSessionThreadWorkflowPort {
  constructor(private readonly options: {
    gatewayId: string; adminOpenIds: readonly string[]; store: WorkerSessionThreadApplicationStore; messaging: Pick<InstanceMessagingPort, "steer" | "interrupt">;
    agentInput: AgentInputWorkflowPort; herdr: Pick<HerdrPort, "getPane">; outbound: OutboundIntentPort; wakeOutbound(): void;
    gatewayEffects: Pick<GatewayEffectPort, "shareConversation">;
    presentation: Pick<ApplicationPresentation, "requestRejected" | "workerStatusSnapshot" | "workerThreadEntry">;
  }) {}

  async handleMessage(message: IncomingLarkMessage): Promise<{ handled: false } | { handled: true; disposition: "agent_input_accepted" | "command_completed" | "rejected" }> {
    const resolution = this.options.store.resolveScope({ chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId });
    if (resolution.kind === "none") return { handled: false };
    if (!this.isOperator(message.actorOpenId)) { await this.reject(message, "你没有 Agent 管理权限。"); return handled("rejected"); }
    if (resolution.kind === "stale") { await this.reject(message, "Worker 对话已失效，请从 Primary 的 `/instances` 重新进入。"); return handled("rejected"); }
    return this.handleActiveMessage(message, resolution);
  }

  async publishFromCard(action: IncomingLarkCardAction, target: WorkerThreadPublicationTarget): Promise<LarkCardActionResult> {
    if (!this.isOperator(action.operatorOpenId)) return warning("你没有 Agent 管理权限。", true);
    const decision = this.options.store.reserveLegacyEntry({ actionMessageId: action.messageId, chatId: action.chatId, target, render: this.options.presentation.workerThreadEntry });
    if (decision.kind === "reserved") { this.options.wakeOutbound(); return success("已提交 Worker 卡片，将发送到群并创建独立对话。"); }
    if (decision.kind === "pending") return success("Worker 对话已受理；如未显示，请查看 `/swarm failures`。");
    if (decision.kind === "existing") {
      try {
        await this.options.gatewayEffects.shareConversation({ conversationId: decision.rootMessageId, messageId: action.messageId, targetConversationId: action.chatId, purpose: "group-thread" });
        return success("已打开 Worker Thread。");
      } catch { return warning("Worker Thread 已存在，但打开失败；请重试。"); }
    }
    return warning("Worker 状态已变化，请刷新实例目录。");
  }

  private async handleActiveMessage(message: IncomingLarkMessage, resolution: Extract<WorkerThreadResolution, { kind: "active" }>): Promise<{ handled: true; disposition: "agent_input_accepted" | "command_completed" | "rejected" }> {
    const target = resolution.target; const text = message.text.trim(); const rootMessageId = target.rootMessageId;
    const actor = { kind: "human" as const, userId: message.actorOpenId, channel: "feishu" as const };
    if (/^\/status$/i.test(text)) {
      await this.options.outbound.enqueueCard(rootMessageId, `worker-thread:status:${message.messageId}`, this.options.presentation.workerStatusSnapshot(target.view, new Date().toISOString()));
      return handled("command_completed");
    }
    const steer = /^\/steer\s+([\s\S]+)$/i.exec(text);
    if (steer) {
      if (!target.activeTurn || !["running", "blocked"].includes(target.activeTurn.state)) { await this.reject(message, "当前没有可补充的 active Worker task。"); return handled("rejected"); }
      const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:worker-thread-steer`, actor, targetInstanceId: target.workerId, targetTurnId: target.activeTurn.id, text: steer[1]!.trim(), resultTargetMessageId: rootMessageId });
      if (result.durableResult === false) { await this.reject(message, `补充当前任务：${result.status}`); return handled("rejected"); }
      return handled("command_completed");
    }
    if (/^\/stop$/i.test(text)) {
      if (!target.activeTurn || target.activeTurn.state !== "running") { await this.reject(message, "当前没有可停止的 active Worker task。"); return handled("rejected"); }
      const result = await this.options.messaging.interrupt({ idempotencyKey: `lark:${message.messageId}:worker-thread-stop`, actor, targetInstanceId: target.workerId, targetTurnId: target.activeTurn.id, resultTargetMessageId: rootMessageId });
      if (result.status !== "interrupted" && result.durableResult === false) { await this.reject(message, `停止当前任务：${result.status}`); return handled("rejected"); }
      return handled("command_completed");
    }
    if (target.agentKind !== "traex" && target.agentKind !== "pi") { await this.reject(message, `Worker Agent ${target.agentKind} 不支持可靠 Agent Input。`); return handled("rejected"); }
    if (!target.paneId) { await this.reject(message, "Worker 尚未连接可提交输入的 Herdr Pane。"); return handled("rejected"); }
    const pane = await this.options.herdr.getPane(target.paneId);
    const observedSessionId = pane?.agentSession?.value ?? null;
    if (!pane?.terminalId || pane.agentKind !== target.agentKind || observedSessionId !== target.nativeSessionId) {
      await this.reject(message, "Worker 运行时身份已变化，请刷新后重试。");
      return handled("rejected");
    }
    const submitted = await this.options.agentInput.submit({
      ingressSource: this.options.gatewayId,
      sourceMessageKey: message.messageId,
      actor: { kind: "human", id: message.actorOpenId, gatewayId: this.options.gatewayId, chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId },
      text: message.text,
      owner: { kind: "worker", id: target.workerId, generation: target.runtimeGeneration },
      paneId: target.paneId,
      terminalId: pane.terminalId,
      expectedAgentKind: target.agentKind,
      expectedSessionId: target.nativeSessionId
    });
    if (submitted.outcome === "conflict") { await this.reject(message, "这条 Worker 消息与已受理内容冲突。"); return handled("rejected"); }
    return handled("agent_input_accepted");
  }

  private isOperator(openId: string): boolean { return this.options.adminOpenIds.includes(openId); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
}

function handled(disposition: "agent_input_accepted" | "command_completed" | "rejected") { return { handled: true as const, disposition }; }
function success(content: string): LarkCardActionResult { return { toast: { type: "success", content } }; }
function warning(content: string, error = false): LarkCardActionResult { return { toast: { type: error ? "error" : "warning", content } }; }
