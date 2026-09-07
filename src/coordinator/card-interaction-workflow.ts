import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardInteractionStore } from "../domain/ports/workflow.js";
import type { IncomingLarkCardAction, LarkCardActionResult } from "../domain/types.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { SessionOperationWorkflowPort } from "./session-operation-workflow.js";

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
  handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void>;
}

export class CardInteractionWorkflow implements CardInteractionWorkflowPort {
  constructor(private readonly options: Options) {}

  async handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (!action.value || typeof action.value !== "object" || Array.isArray(action.value)) return;
    const value = action.value as Record<string, unknown>;
    if (value.action === "open_supplement" || value.action === "submit_supplement") return this.options.presentation.interactionToast("warning", "当前 Agent 不支持立即补充；请将内容作为普通消息发送。");
    if (value.action === "convert_queued_prompt" || value.action === "enqueue_failed_steering") return this.options.presentation.interactionToast("warning", "该操作已失效，请刷新卡片后重试。");
    if (value.action === "open_more_actions") return this.openMoreActions(action, value);
    if (value.action === "view_queue") return this.viewQueue(action, value);
    if (value.action === "view_recovery") return this.viewRecovery(action, value);
    if (value.action === "create_new_task") return { card: this.options.presentation.interactionGuidance({ kind: "new_task" }) };
    if (value.action === "open_rename") return this.openRename(action, value);
    if (value.action === "open_reattach") return this.openReattach(action, value);
    if (typeof value.action === "string" && (value.action.startsWith("session_") || value.action === "submit_rename" || value.action === "submit_reattach")) return this.sessionControl(action, value);
    return undefined;
  }

  private openMoreActions(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    const creator = binding.creatorOpenId === action.operatorOpenId;
    const interaction = creator ? this.options.store.createCardInteraction({ id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation, actorOpenId: action.operatorOpenId, actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }) : null;
    return { card: this.options.presentation.moreActions({ bindingId: binding.id, bindingGeneration: binding.generation, ...(interaction ? { interactionId: interaction.id } : {}), creator, lifecycle: binding.lifecycle, attachment: binding.attachment }) };
  }

  private openRename(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, true);
    const interaction = stringValue(value.interactionId);
    return binding && interaction ? { card: this.options.presentation.renameInput({ interactionId: interaction, bindingId: binding.id, bindingGeneration: binding.generation }) } : this.options.presentation.interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private viewQueue(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: this.options.presentation.queueSummary({ queued: this.options.store.countPendingPrompts(binding.id) }) };
  }

  private viewRecovery(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: this.options.presentation.interactionGuidance({ kind: "recovery", message: this.options.store.loadTopicView(binding.id)?.notice ?? null }) };
  }

  private openReattach(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, true); const interaction = stringValue(value.interactionId);
    return binding && interaction ? { card: this.options.presentation.reattachInput({ interactionId: interaction, bindingId: binding.id, bindingGeneration: binding.generation }) } : this.options.presentation.interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private async sessionControl(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    if (value.action !== "session_status" && !(this.options.adminOpenIds ?? []).includes(action.operatorOpenId)) return this.options.presentation.interactionToast("error", "你没有管理权限。");
    const binding = this.freshBinding(action, value, value.action !== "session_status");
    if (!binding) return this.options.presentation.interactionToast("error", "操作无权限，或会话状态已变化。");
    if (value.action === "submit_rename" && !action.formValues?.title?.trim()) return this.options.presentation.interactionToast("warning", "请输入新标题。");
    if (value.action === "submit_reattach" && !action.formValues?.pane_id?.trim()) return this.options.presentation.interactionToast("warning", "请输入 Pane ID。");
    if (value.action === "submit_rename" && action.formValues!.title!.trim().length > 500) return this.options.presentation.interactionToast("warning", "标题过长，请控制在 500 个字符以内。");
    if (value.action === "submit_reattach" && action.formValues!.pane_id!.trim().length > 500) return this.options.presentation.interactionToast("warning", "Pane ID 过长，请刷新后重试。");
    if (value.action === "session_model") return this.options.presentation.interactionToast("warning", "运行中的 Agent 不支持远程切换模型。请在创建或替换 Agent 时选择模型。");
    const durableKind = sessionOperationKind(value.action);
    if (durableKind) {
      const interactionId = stringValue(value.interactionId);
      if (!interactionId) return this.options.presentation.interactionToast("error", "操作入口已失效。");
      const argument = durableKind === "rename" ? action.formValues!.title!.trim() : durableKind === "reattach" ? action.formValues!.pane_id!.trim() : null;
      const outcome = this.options.sessionOperations.accept(action, binding, interactionId, durableKind, argument);
      if (outcome === "accepted" || outcome === "duplicate") return this.options.presentation.interactionToast("success", outcome === "accepted" ? "操作已受理。" : "这项操作已处理。");
      return this.options.presentation.interactionToast(outcome === "unauthorized" ? "error" : "warning", outcome === "unauthorized" ? "操作无权限。" : "操作入口已失效或会话状态已变化。");
    }
    switch (value.action) {
      case "session_status": await this.options.sessionAdministration.emitStatus(binding); break;
      default: return this.options.presentation.interactionToast("warning", "未知操作。");
    }
    return this.options.presentation.interactionToast("success", "操作已受理。");
  }

  private freshBinding(action: IncomingLarkCardAction, value: Record<string, unknown>, creatorOnly: boolean) {
    const bindingId = stringValue(value.bindingId); const generation = numberValue(value.bindingGeneration);
    const binding = bindingId ? this.options.store.getBinding(bindingId) : null;
    if (!binding || binding.chatId !== action.chatId || (generation !== null && binding.generation !== generation)) return null;
    if (creatorOnly && binding.creatorOpenId !== action.operatorOpenId) return null;
    return binding;
  }
}

function sessionOperationKind(action: unknown): import("../domain/types.js").SessionOperationKind | null {
  if (action === "session_stop") return "stop";
  if (action === "session_model") return "model";
  if (action === "session_reset") return "reset";
  if (action === "session_archive") return "archive";
  if (action === "submit_rename") return "rename";
  if (action === "submit_reattach") return "reattach";
  if (action === "session_replace") return "replace";
  if (action === "session_resume") return "resume";
  if (action === "session_pane_close") return "pane_close";
  return null;
}

function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null; }
