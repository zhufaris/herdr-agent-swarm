import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../adapters/lark-ingress.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { WorkerSessionThreadApplicationStore, WorkerSessionThreadWorkflowPort, WorkerThreadPublicationTarget, WorkerThreadResolution } from "../domain/ports/worker-session-thread.js";
import type { InstanceMessagingWorkflow } from "./instance-messaging-workflow.js";

export class WorkerSessionThreadWorkflow implements WorkerSessionThreadWorkflowPort {
  constructor(private readonly options: {
    adminOpenIds: readonly string[]; store: WorkerSessionThreadApplicationStore; messaging: InstanceMessagingWorkflow; outbound: OutboundIntentPort; wakeOutbound(): void;
    presentation: Pick<ApplicationPresentation, "requestRejected" | "workerStatusSnapshot" | "workerThreadEntry" | "workerThreadAccepted">;
  }) {}

  async handleMessage(message: IncomingLarkMessage): Promise<{ handled: false } | { handled: true; disposition: "prompt_queued" | "command_completed" | "rejected" }> {
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
    if (decision.kind === "existing") return success(`Worker 对话已存在（${decision.rootMessageId}）。`);
    return warning("Worker 状态已变化，请刷新实例目录。");
  }

  private async handleActiveMessage(message: IncomingLarkMessage, resolution: Extract<WorkerThreadResolution, { kind: "active" }>): Promise<{ handled: true; disposition: "prompt_queued" | "command_completed" | "rejected" }> {
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
    if (text.startsWith("/")) { await this.reject(message, "Worker 对话仅支持 `/status`、`/steer <文本>`、`/stop`；管理命令请回到 Primary Thread。"); return handled("rejected"); }
    const submitted = await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor, projectId: target.projectId, targetInstanceId: target.workerId, content: { kind: "turn", text: message.text }, source: { messageId: message.messageId, rootMessageId } });
    await this.options.outbound.enqueueCard(rootMessageId, `worker-thread:accepted:${message.messageId}`, this.options.presentation.workerThreadAccepted({ workerName: target.workerName, queuePosition: submitted.card?.queuePosition ?? 1, duplicate: !submitted.inserted }));
    return handled("prompt_queued");
  }

  private isOperator(openId: string): boolean { return this.options.adminOpenIds.includes(openId); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
}

function handled(disposition: "prompt_queued" | "command_completed" | "rejected") { return { handled: true as const, disposition }; }
function success(content: string): LarkCardActionResult { return { toast: { type: "success", content } }; }
function warning(content: string, error = false): LarkCardActionResult { return { toast: { type: error ? "error" : "warning", content } }; }
