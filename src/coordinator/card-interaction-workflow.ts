import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BindingPromptWorkflowPort } from "../domain/ports/prompt-acceptance.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardInteractionStore } from "../domain/ports/workflow.js";
import type { IncomingLarkCardAction, LarkCardActionResult } from "../domain/types.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { SwarmCommandRuntime } from "./swarm-command-gateway.js";
import type { CardActionCommand, SessionCardActionCommand } from "./card-action-command.js";
import type { ProjectConfig } from "../domain/types.js";
import { ProjectCatalog } from "./project-catalog.js";
import type { AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { InstanceMessagingPort } from "../domain/ports/instance-workflows.js";
export type { SessionCardActionCommand } from "./card-action-command.js";

interface Options {
  store: CardInteractionStore;
  projects: readonly ProjectConfig[];
  adminOpenIds: readonly string[];
  sessionAdministration: Pick<SessionAdministrationWorkflowPort, "emitStatus">;
  commands: Pick<SwarmCommandRuntime, "submit">;
  bindingPrompts: Pick<BindingPromptWorkflowPort, "ignorePrimaryCompletionAction">;
  agentInput: Pick<AgentInputWorkflowPort, "resume">;
  workerMessaging?: Pick<InstanceMessagingPort, "decideFreshWorkerCompletionReview">;
  convergeTurnCard(segmentId: string): Promise<void>;
  logger: Pick<Logger, "info" | "warn">;
  presentation: Pick<ApplicationPresentation, "interactionToast" | "interactionGuidance" | "moreActions" | "reattachInput" | "renameInput" | "primaryContinuationInput">;
}

export interface CardInteractionWorkflowPort {
  handle(action: IncomingLarkCardAction, command: SessionCardActionCommand | Extract<CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult>;
}

export class CardInteractionWorkflow implements CardInteractionWorkflowPort {
  private readonly projects: ProjectCatalog;
  constructor(private readonly options: Options) { this.projects = new ProjectCatalog(options.projects ?? []); }

  async handle(action: IncomingLarkCardAction, command: SessionCardActionCommand | Extract<CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult> {
    if (command.kind === "completion-action") return this.submitCompletionAction(action, command);
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

  private async submitCompletionAction(action: IncomingLarkCardAction, command: Extract<CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult> {
    if (command.ownerKind === undefined) {
      const occurredAt = new Date().toISOString();
      let decision: { kind: "ignored"; changed: boolean; segmentId?: string } | { kind: "submission"; submissionId: string; inserted: boolean; segmentId?: string };
      try {
        const ownerKind = this.options.store.getCompletionReviewOwnerKind(command.actionSetId);
        if (ownerKind === "primary-segment" || ownerKind === "primary-prompt") {
          const primary = this.options.store.decidePrimaryCompletionReview({
            actionSetId: command.actionSetId, optionId: command.optionId,
            messageId: action.messageId, actorOpenId: action.operatorOpenId, chatId: action.chatId, occurredAt
          });
          decision = primary.kind === "ignored"
            ? { kind: "ignored", changed: primary.changed, ...(primary.ownerKind === "primary-segment" ? { segmentId: primary.segmentId } : {}) }
            : { kind: "submission", submissionId: primary.submissionId, inserted: primary.inserted, ...(primary.ownerKind === "primary-segment" ? { segmentId: primary.segmentId } : {}) };
        } else if (ownerKind === "worker-turn") {
          if (!this.options.workerMessaging) return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
          const worker = await this.options.workerMessaging.decideFreshWorkerCompletionReview({
            actionSetId: command.actionSetId, optionId: command.optionId,
            messageId: action.messageId, chatId: action.chatId,
            actor: { kind: "human", userId: action.operatorOpenId, channel: "feishu" }
          });
          if (worker.kind === "ignored") return this.options.presentation.interactionToast("success", "已忽略。");
          return this.options.presentation.interactionToast("success", worker.inserted ? `快捷消息已提交，当前队列第 ${worker.card.queuePosition} 位。` : "这条快捷消息已提交。");
        } else {
          return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
        }
      } catch {
        return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
      }
      if (decision.kind === "ignored") {
        if (decision.changed && decision.segmentId) {
          try { await this.options.convergeTurnCard(decision.segmentId); }
          catch (error) { this.options.logger.warn({ error, actionSetId: command.actionSetId }, "Completion Review convergence failed after Ignore"); }
        }
        return this.options.presentation.interactionToast("success", "已忽略。");
      }
      let admission;
      try { admission = await this.options.agentInput.resume(decision.submissionId); }
      catch (error) {
        this.options.logger.warn({ error, actionSetId: command.actionSetId }, "Completion Review input resume failed after durable decision");
        return this.options.presentation.interactionToast("warning", "选择已记录，正在确认中，请勿重复提交。");
      }
      if (decision.inserted && decision.segmentId) {
        try { await this.options.convergeTurnCard(decision.segmentId); }
        catch (error) { this.options.logger.warn({ error, actionSetId: command.actionSetId }, "Completion Review convergence failed after durable decision"); }
      }
      switch (admission.state) {
        case "prepared": case "observed": case "terminal":
          return this.options.presentation.interactionToast("success", "已提交选择。");
        case "recorded": case "attempting": case "uncertain":
          return this.options.presentation.interactionToast("warning", "选择正在确认中，请勿重复提交。");
        case "cancelled":
          return this.options.presentation.interactionToast("warning", "选择未提交，请发送新的消息。");
      }
    }
    if (action.messageId !== command.cardMessageId) return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
    if (command.ownerKind === "primary-segment") {
      try {
        const occurredAt = new Date().toISOString();
        if ("ignore" in command) {
          const result = this.options.store.ignorePrimarySegmentCompletionChoice({
            actionSetId: command.actionSetId, ownerSegmentId: command.ownerId, ownerGeneration: command.ownerGeneration,
            cardMessageId: command.cardMessageId, actorOpenId: action.operatorOpenId, chatId: action.chatId, occurredAt
          });
          if (result.changed) await this.options.convergeTurnCard(result.ownerId);
          return this.options.presentation.interactionToast("success", "已忽略。");
        }
        if (!("optionId" in command)) throw new Error("Segment completion actions require a declared choice");
        const result = this.options.store.acceptPrimarySegmentCompletionChoice({
          actionSetId: command.actionSetId, optionId: command.optionId, ownerSegmentId: command.ownerId,
          ownerGeneration: command.ownerGeneration, cardMessageId: command.cardMessageId,
          actorOpenId: action.operatorOpenId, chatId: action.chatId, occurredAt
        });
        const admission = await this.options.agentInput.resume(result.submissionId);
        if (result.inserted) await this.options.convergeTurnCard(result.segmentId);
        switch (admission.state) {
          case "prepared": case "observed": case "terminal":
            return this.options.presentation.interactionToast("success", "已提交选择。");
          case "recorded": case "attempting": case "uncertain":
            return this.options.presentation.interactionToast("warning", "选择正在确认中，请勿重复提交。");
          case "cancelled":
            return this.options.presentation.interactionToast("warning", "选择未提交，请发送新的消息。");
        }
      } catch {
        return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
      }
    }
    if (command.ownerKind !== "primary-prompt") return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
    const parent = this.options.store.getPrompt(command.ownerId);
    const binding = parent ? this.options.store.getBinding(parent.bindingId) : null;
    if (!parent || !binding || binding.chatId !== action.chatId || binding.generation !== command.ownerGeneration) return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
    try {
      if ("ignore" in command) {
        await this.options.bindingPrompts.ignorePrimaryCompletionAction({
          binding, actionSetId: command.actionSetId, ownerPromptId: command.ownerId, ownerGeneration: command.ownerGeneration,
          cardMessageId: command.cardMessageId, actor: { openId: action.operatorOpenId }
        });
        return this.options.presentation.interactionToast("success", "已忽略。");
      }
      return this.options.presentation.interactionToast("warning", "该历史快捷输入已停用。请在当前会话直接发送消息，系统会通过 Agent Input 提交。");
    } catch {
      return this.options.presentation.interactionToast("warning", "该快捷操作已失效，请发送新的消息。");
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
    return this.options.presentation.interactionToast("warning", "Prompt 队列已停用；请使用 `/swarm status` 查看 Submission Intent、Core 投影与投递状态。");
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

  private async submitPrimaryContinuation(action: IncomingLarkCardAction, command: Extract<SessionCardActionCommand, { action: "primary_continue_submit" }>): Promise<LarkCardActionResult> {
    if (command.requestedBy !== action.operatorOpenId) return this.options.presentation.interactionToast("error", "只有发起此操作的用户可以提交。");
    const text = action.formValues?.continuation_text?.trim() ?? "";
    if (!text) return this.options.presentation.interactionToast("warning", "请说明从哪里继续，以及不要重复哪些内容。");
    const binding = this.freshBinding(action, command, true);
    if (!binding) return this.options.presentation.interactionToast("warning", "会话状态已变化，未创建续做任务。");
    return this.options.presentation.interactionToast("warning", "历史续做表单已停用，且不会创建 Prompt。请复制续做说明并在当前会话直接发送，以通过 Agent Input 提交。");
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
      const receipt = await this.options.commands.submit({ source: "card", action, bindingId: binding.id, bindingGeneration: command.bindingGeneration!, interactionId: command.interactionId, command: cardCommand(command.operation, argument) });
      if (receipt.outcome === "accepted") return this.options.presentation.interactionToast("success", "操作已受理。");
      return this.options.presentation.interactionToast(receipt.outcome === "rejected" && receipt.code.includes("unauthorized") ? "error" : "warning", receipt.outcome === "rejected" && receipt.code.includes("unauthorized") ? "操作无权限。" : "操作入口已失效或会话状态已变化。");
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

function cardCommand(kind: "stop" | "reset" | "archive" | "resume" | "replace" | "pane_close" | "rename" | "reattach", argument: string | null) {
  switch (kind) {
    case "stop": return { kind: "stop" } as const;
    case "reset": return { kind: "reset", title: null } as const;
    case "archive": return { kind: "archive" } as const;
    case "resume": return { kind: "resume" } as const;
    case "replace": return { kind: "replace" } as const;
    case "pane_close": return { kind: "pane_close_request" } as const;
    case "rename": return { kind: "rename", title: argument! } as const;
    case "reattach": return { kind: "reattach", paneId: argument! } as const;
  }
}
