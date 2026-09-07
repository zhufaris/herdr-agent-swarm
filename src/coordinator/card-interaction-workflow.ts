import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardInteractionStore } from "../domain/ports/workflow.js";
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
  presentation: Pick<ApplicationPresentation, "answerCard" | "interactionToast" | "interactionGuidance" | "moreActions" | "queueSummary" | "reattachInput" | "renameInput">;
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

  private async sessionControl(action: IncomingLarkCardAction, command: Exclude<SessionCardActionCommand, { action: "open_more_actions" | "view_queue" | "view_recovery" | "create_new_task" | "open_rename" | "open_reattach" }>): Promise<LarkCardActionResult> {
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
