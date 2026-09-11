import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { LarkPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { DeliveryRecoveryStore } from "../domain/ports/workflow.js";
import type { IncomingLarkCardAction } from "../domain/types.js";
import type { TopicPaneDirectoryEntry } from "../domain/ports/presentation.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options {
  store: DeliveryRecoveryStore;
  lark: Pick<LarkPort, "replyText" | "shareThread">;
  outbound: Pick<OutboundIntentPort, "enqueueCard" | "enqueueCardUpdate">;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  presentation: Pick<ApplicationPresentation, "failures" | "mainCard">;
}

export interface DeliveryRecoveryWorkflowPort {
  openThread(action: IncomingLarkCardAction, bindingId: string): Promise<void>;
  decideDeadLetter(action: IncomingLarkCardAction, replyId: string, decision: "retry_dead_letter" | "dismiss_dead_letter"): Promise<void>;
  sendPaneCard(action: IncomingLarkCardAction, entry: Pick<TopicPaneDirectoryEntry, "bindingId" | "bindingGeneration" | "paneId" | "sourceMainMessageId">): Promise<"sent" | "stale">;
}

export class DeliveryRecoveryWorkflow implements DeliveryRecoveryWorkflowPort {
  constructor(private readonly options: Options) {}

  async openThread(action: IncomingLarkCardAction, bindingId: string): Promise<void> {
    const { store, lark, logger } = this.options;
    const binding = store.getBinding(bindingId);
    if (!binding || binding.chatId !== action.chatId) return;
    const target = binding.topicId ?? binding.rootMessageId;
    if (!target) return;
    try {
      await lark.shareThread(target, { messageId: action.messageId, chatId: action.chatId });
      store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "shared" });
    } catch (error) {
      logger.error({ event: "thread-entry-share-failed", err: safeLogError(error), bindingId: binding.id, actionMessageId: action.messageId, outcome: "failed" }, "failed to share project thread entry");
      await lark.replyText(action.messageId, "话题入口发送失败，请重新执行 `/swarm spaces` 后重试。");
      store.audit({ actorOpenId: action.operatorOpenId, action: "thread.open", target: binding.id, outcome: "failed" });
    }
  }

  async decideDeadLetter(action: IncomingLarkCardAction, replyId: string, decision: "retry_dead_letter" | "dismiss_dead_letter"): Promise<void> {
    const { store, outbound, logger } = this.options;
    const outcome = decision === "retry_dead_letter" ? store.retryDeadLetter(replyId, action.chatId, action.operatorOpenId) : store.dismissDeadLetter(replyId, action.chatId, action.operatorOpenId);
    logger.info({ event: "dead-letter-action-decided", replyId, action: decision, outcome }, "processed dead-letter action");
    if (outcome === "retried") this.options.outboundWork.wake();
    const notice = outcome === "retried" ? "已重新提交该消息发送；不会重放 TraeX 任务。" : outcome === "dismissed" ? "已忽略该发送失败并保留历史记录。" : "该操作已失效或无权执行。";
    await outbound.enqueueCardUpdate(null, action.messageId, `failures:${action.messageId}:${replyId}:${outcome}`, this.options.presentation.failures(store.listFailures(action.chatId), notice)[0]!);
  }

  async sendPaneCard(action: IncomingLarkCardAction, entry: Pick<TopicPaneDirectoryEntry, "bindingId" | "bindingGeneration" | "paneId" | "sourceMainMessageId">): Promise<"sent" | "stale"> {
    const binding = this.options.store.getBinding(entry.bindingId);
    if (!binding || binding.chatId !== action.chatId || binding.generation !== entry.bindingGeneration || binding.paneId !== entry.paneId
      || binding.statusMessageId !== entry.sourceMainMessageId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return "stale";
    const view = this.options.store.loadTopicView(binding.id);
    if (!view) return "stale";
    await this.options.outbound.enqueueCard(action.messageId, `pane-card-send:${action.messageId}:${binding.id}:${binding.generation}:${entry.sourceMainMessageId}`, this.options.presentation.mainCard(view), binding.id);
    this.options.store.audit({ actorOpenId: action.operatorOpenId, action: "pane.card.send", target: binding.id, outcome: "accepted" });
    return "sent";
  }
}
