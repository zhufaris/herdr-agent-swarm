import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardInteractionStore } from "../domain/ports/workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { IncomingLarkCardAction, LarkCardActionResult } from "../domain/types.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { SessionOperationWorkflowPort } from "./session-operation-workflow.js";
import type { SessionCardActionCommand } from "./card-action-command.js";
export type { SessionCardActionCommand } from "./card-action-command.js";

interface Options {
  store: CardInteractionStore;
  adminOpenIds: readonly string[];
  sessionAdministration: Pick<SessionAdministrationWorkflowPort, "emitStatus">;
  sessionOperations: Pick<SessionOperationWorkflowPort, "accept">;
  wakePrompt(bindingId: string): void;
  logger: Pick<Logger, "info" | "warn">;
  presentation: Pick<ApplicationPresentation, "answerCard" | "interactionToast" | "interactionGuidance" | "moreActions" | "queueSummary" | "reattachInput" | "renameInput" | "primaryContinuationInput">;
}

export interface CardInteractionWorkflowPort {
  handle(action: IncomingLarkCardAction, command: SessionCardActionCommand): Promise<LarkCardActionResult>;
}

export class CardInteractionWorkflow implements CardInteractionWorkflowPort {
  constructor(private readonly options: Options) {}

  async handle(action: IncomingLarkCardAction, command: SessionCardActionCommand): Promise<LarkCardActionResult> {
    switch (command.action) {
      case "open_more_actions": return this.openMoreActions(action, command);
      case "view_queue": return this.viewQueue(action, command);
      case "view_recovery": return this.viewRecovery(action, command);
      case "create_new_task": return { card: this.options.presentation.interactionGuidance({ kind: "new_task" }) };
      case "open_rename": return this.openRename(action, command);
      case "open_reattach": return this.openReattach(action, command);
      case "primary_continue_form": return this.openPrimaryContinuation(action, command);
      case "primary_continue_submit": return this.submitPrimaryContinuation(action, command);
      default: return this.sessionControl(action, command);
    }
  }

  private openMoreActions(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "open_more_actions" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    const creator = binding.creatorOpenId === action.operatorOpenId;
    const interaction = creator ? this.options.store.createCardInteraction({ id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation, actorOpenId: action.operatorOpenId, actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }) : null;
    return { card: this.options.presentation.moreActions({ bindingId: binding.id, bindingGeneration: binding.generation, ...(interaction ? { interactionId: interaction.id } : {}), creator, lifecycle: binding.lifecycle, attachment: binding.attachment }) };
  }

  private openRename(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "open_rename" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, true);
    return binding ? { card: this.options.presentation.renameInput({ interactionId: command.interactionId, bindingId: binding.id, bindingGeneration: binding.generation }) } : this.options.presentation.interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private viewQueue(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "view_queue" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: this.options.presentation.queueSummary({ queued: this.options.store.countPendingPrompts(binding.id) }) };
  }

  private viewRecovery(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "view_recovery" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: this.options.presentation.interactionGuidance({ kind: "recovery", message: this.options.store.loadTopicView(binding.id)?.notice ?? null }) };
  }

  private openReattach(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "open_reattach" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, true);
    return binding ? { card: this.options.presentation.reattachInput({ interactionId: command.interactionId, bindingId: binding.id, bindingGeneration: binding.generation }) } : this.options.presentation.interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private openPrimaryContinuation(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "primary_continue_form" }>): LarkCardActionResult {
    const binding = this.freshBinding(action, command, true);
    const parent = binding ? this.options.store.getPrompt(command.parentPromptId) : null;
    const view = parent ? this.options.store.loadRunCard(parent.id) : null;
    if (!binding || !parent || !view || parent.bindingId !== binding.id || parent.state !== "failed" || parent.error !== HUMAN_INTERRUPTION_NOTICE || view.answerMessageId !== command.sourceAnswerMessageId) return this.options.presentation.interactionToast("warning", "该中断任务已不可继续，请刷新卡片后重试。");
    const interaction = this.options.store.createCardInteraction({ id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation, actorOpenId: action.operatorOpenId, actionKind: "continuation", parentPromptId: parent.id, targetPromptId: null, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    return { card: this.options.presentation.primaryContinuationInput({ interactionId: interaction.id, bindingId: binding.id, bindingGeneration: binding.generation, parentPromptId: parent.id, sourceAnswerMessageId: command.sourceAnswerMessageId, requestedBy: action.operatorOpenId }) };
  }

  private submitPrimaryContinuation(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "primary_continue_submit" }>): LarkCardActionResult {
    if (command.requestedBy !== action.operatorOpenId) return this.options.presentation.interactionToast("error", "只有发起此操作的用户可以提交。");
    const text = action.formValues?.continuation_text?.trim() ?? "";
    if (!text) return this.options.presentation.interactionToast("warning", "请说明从哪里继续，以及不要重复哪些内容。");
    if (text.length > 12_000) return this.options.presentation.interactionToast("warning", "续做说明过长，请控制在 12000 个字符以内。");
    const binding = this.freshBinding(action, command, true);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，未创建续做任务。");
    const id = randomUUID();
    const view = createQueuedRunCard({ promptId: id, bindingId: binding.id, bindingGeneration: binding.generation, conversionParentPromptId: command.parentPromptId, title: binding.title, agentKind: binding.agentKind, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: text, queuePosition: this.options.store.countPendingPrompts(binding.id) + 1, occurredAt: new Date().toISOString() });
    try {
      const result = this.options.store.acceptInterruptedContinuation({ interactionId: command.interactionId, parentPromptId: command.parentPromptId, sourceAnswerMessageId: command.sourceAnswerMessageId, expectedBindingGeneration: binding.generation, actorOpenId: action.operatorOpenId, accepted: { prompt: { id, bindingId: binding.id, larkMessageId: `card:${command.interactionId}`, actorOpenId: action.operatorOpenId, body: text, parentPromptId: command.parentPromptId }, view, rootMessageId: binding.rootMessageId ?? action.messageId, answerCard: this.options.presentation.answerCard(view), expectedBindingGeneration: binding.generation } });
      if (result.inserted) this.options.wakePrompt(binding.id);
      return this.options.presentation.interactionToast("success", result.inserted ? `续做任务已创建，当前队列第 ${result.view.queuePosition} 位。` : "这条续做任务已创建。");
    } catch { return this.options.presentation.interactionToast("warning", "该中断任务已不可继续，未创建新任务。"); }
  }

  private async sessionControl(action: IncomingLarkCardAction, command: Exclude<SessionCardActionCommand, { action: "open_more_actions" | "view_queue" | "view_recovery" | "create_new_task" | "open_rename" | "open_reattach" | "primary_continue_form" | "primary_continue_submit" }>): Promise<LarkCardActionResult> {
    if (command.action !== "session_status" && !(this.options.adminOpenIds ?? []).includes(action.operatorOpenId)) return this.options.presentation.interactionToast("error", "你没有管理权限。");
    const binding = this.freshBinding(action, command, command.action !== "session_status");
    if (!binding) return this.options.presentation.interactionToast("error", "操作无权限，或会话状态已变化。");
    if (command.action === "submit_rename" && !action.formValues?.title?.trim()) return this.options.presentation.interactionToast("warning", "请输入新标题。");
    if (command.action === "submit_reattach" && !action.formValues?.pane_id?.trim()) return this.options.presentation.interactionToast("warning", "请输入 Pane ID。");
    if (command.action === "submit_rename" && action.formValues!.title!.trim().length > 500) return this.options.presentation.interactionToast("warning", "标题过长，请控制在 500 个字符以内。");
    if (command.action === "submit_reattach" && action.formValues!.pane_id!.trim().length > 500) return this.options.presentation.interactionToast("warning", "Pane ID 过长，请刷新后重试。");
    if (command.action === "session_model") return this.options.presentation.interactionToast("warning", "运行中的 Agent 不支持远程切换模型。请在创建或替换 Agent 时选择模型。");
    if (command.action !== "session_status") {
      const argument = command.operation === "rename" ? action.formValues!.title!.trim() : command.operation === "reattach" ? action.formValues!.pane_id!.trim() : null;
      const outcome = this.options.sessionOperations.accept(action, binding, command.interactionId, command.operation, argument);
      if (outcome === "accepted" || outcome === "duplicate") return this.options.presentation.interactionToast("success", outcome === "accepted" ? "操作已受理。" : "这项操作已处理。");
      return this.options.presentation.interactionToast(outcome === "unauthorized" ? "error" : "warning", outcome === "unauthorized" ? "操作无权限。" : "操作入口已失效或会话状态已变化。");
    }
    await this.options.sessionAdministration.emitStatus(binding);
    return this.options.presentation.interactionToast("success", "操作已受理。");
  }

  private freshBinding(action: IncomingLarkCardAction, command: { bindingId: string; bindingGeneration: number | null }, creatorOnly: boolean) {
    const binding = this.options.store.getBinding(command.bindingId);
    if (!binding || binding.chatId !== action.chatId || (command.bindingGeneration !== null && binding.generation !== command.bindingGeneration)) return null;
    if (creatorOnly && binding.creatorOpenId !== action.operatorOpenId) return null;
    return binding;
  }
}

const HUMAN_INTERRUPTION_NOTICE = "TraeX turn was interrupted by a human operator";
