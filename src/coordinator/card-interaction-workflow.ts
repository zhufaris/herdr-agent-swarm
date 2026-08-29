import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import { interactionToast, renderInteractionGuidanceCard, renderMoreActionsCard, renderQueueSummaryCard, renderReattachInputCard, renderRenameInputCard, renderSupplementInputCard } from "../cards/interaction-card.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { BindingStorePort } from "../domain/ports.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../domain/types.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";

interface Options {
  store: Pick<BindingStorePort, "createCardInteraction" | "getCardInteraction" | "consumeCardInteraction" | "convertQueuedPromptToSteering" | "convertFailedSteeringToTurn" | "getBinding" | "getPrompt" | "loadRunCard" | "countPendingPrompts" | "loadTopicView">;
  paneControl: Pick<PaneControlWorkflowPort, "steer" | "stop">;
  sessionAdministration: SessionAdministrationWorkflowPort;
  provisioning: Pick<BindingProvisioningWorkflowPort, "reset" | "reattach" | "replace">;
  paneClosure: Pick<PaneClosureWorkflowPort, "requestPaneClose">;
  modelSelection: Pick<ModelSelectionWorkflowPort, "runModel">;
  activeTurn(bindingId: string): { promptId: string; paneId: string } | null;
  isSteerable(turn: { promptId: string; paneId: string }): Promise<boolean>;
  wakeSteering(bindingId: string, parentPromptId: string): void;
  wakePrompt(bindingId: string): void;
  logger: Pick<Logger, "info" | "warn">;
}

export interface CardInteractionWorkflowPort {
  handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void>;
}

export class CardInteractionWorkflow implements CardInteractionWorkflowPort {
  constructor(private readonly options: Options) {}

  async handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (!action.value || typeof action.value !== "object" || Array.isArray(action.value)) return;
    const value = action.value as Record<string, unknown>;
    if (value.action === "open_supplement") return this.openSupplement(action, value);
    if (value.action === "submit_supplement") return this.submitSupplement(action, value);
    if (value.action === "convert_queued_prompt") return this.convertQueuedPrompt(action, value);
    if (value.action === "enqueue_failed_steering") return this.enqueueFailedSteering(action, value);
    if (value.action === "open_more_actions") return this.openMoreActions(action, value);
    if (value.action === "view_queue") return this.viewQueue(action, value);
    if (value.action === "view_recovery") return this.viewRecovery(action, value);
    if (value.action === "create_new_task") return { card: renderInteractionGuidanceCard({ kind: "new_task" }) };
    if (value.action === "open_rename") return this.openRename(action, value);
    if (value.action === "open_reattach") return this.openReattach(action, value);
    if (typeof value.action === "string" && (value.action.startsWith("session_") || value.action === "submit_rename" || value.action === "submit_reattach")) return this.sessionControl(action, value);
  }

  private openSupplement(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const bindingId = stringValue(value.bindingId); let generation = numberValue(value.bindingGeneration);
    const binding = bindingId ? this.options.store.getBinding(bindingId) : null;
    generation ??= binding?.generation ?? null;
    const active = binding ? this.options.activeTurn(binding.id) : null;
    if (!binding || generation === null || binding.generation !== generation || !active || binding.lifecycle !== "active") return interactionToast("warning", "当前任务已结束或状态已变化，请刷新后重试。");
    const interaction = this.options.store.createCardInteraction({
      id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation, actorOpenId: action.operatorOpenId,
      actionKind: "supplement", parentPromptId: active.promptId, targetPromptId: null,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    });
    return { toast: { type: "success", content: "请输入补充内容" }, card: renderSupplementInputCard({ interactionId: interaction.id, bindingId: binding.id, bindingGeneration: binding.generation }) };
  }

  private async submitSupplement(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const interactionId = stringValue(value.interactionId); const bindingId = stringValue(value.bindingId); const generation = numberValue(value.bindingGeneration);
    const text = action.formValues?.supplement_text?.trim();
    if (!interactionId || !bindingId || generation === null || !text) return interactionToast("warning", "请输入补充内容。");
    const interaction = this.options.store.getCardInteraction(interactionId);
    const binding = this.options.store.getBinding(bindingId);
    const active = binding ? this.options.activeTurn(binding.id) : null;
    if (!interaction || interaction.actionKind !== "supplement" || !binding || binding.generation !== generation || interaction.bindingId !== bindingId || interaction.bindingGeneration !== generation) return interactionToast("warning", "补充入口已失效，内容未发送。");
    if (interaction.actorOpenId !== action.operatorOpenId) return interactionToast("error", "这张输入卡仅限打开它的人使用。");
    if (interaction.state === "consumed") return interactionToast("success", "这条补充已处理。");
    if (interaction.expiresAt <= new Date().toISOString() || !active || active.promptId !== interaction.parentPromptId) return interactionToast("warning", "任务刚刚结束，补充内容未发送。");
    const message: IncomingLarkMessage = { eventId: `card:${interactionId}`, messageId: `card:${interactionId}`, chatId: action.chatId, topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: action.operatorOpenId, text, mentionsBot: true, isRootMessage: false };
    const accepted = await this.options.paneControl.steer(message, binding, text, interaction.parentPromptId ?? undefined);
    if (!accepted) return interactionToast("warning", "原任务已经结束，补充内容未发送。");
    const consumed = this.options.store.consumeCardInteraction({ id: interactionId, actorOpenId: action.operatorOpenId, bindingId, bindingGeneration: generation, now: new Date().toISOString(), resultCode: "accepted" });
    return consumed.outcome === "consumed" || consumed.outcome === "duplicate" ? interactionToast("success", "已补充到当前任务。") : interactionToast("warning", "补充入口已失效，请检查当前任务状态。");
  }

  private async convertQueuedPrompt(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    let interactionId = stringValue(value.interactionId); const bindingId = stringValue(value.bindingId); let generation = numberValue(value.bindingGeneration);
    const capturedParentPromptId = stringValue(value.parentPromptId);
    let interaction = interactionId ? this.options.store.getCardInteraction(interactionId) : null;
    if (!interaction && bindingId) {
      const binding = this.options.store.getBinding(bindingId); const active = binding ? this.options.activeTurn(binding.id) : null;
      const targetPromptId = stringValue(value.targetPromptId);
      if (!binding || !active || !capturedParentPromptId || active.promptId !== capturedParentPromptId || !targetPromptId || generation === null || binding.generation !== generation || binding.lifecycle !== "active") return interactionToast("warning", "当前任务已结束，原消息仍按原顺序排队。");
      interaction = this.options.store.createCardInteraction({ id: randomUUID(), bindingId, bindingGeneration: generation, actorOpenId: action.operatorOpenId, actionKind: "convert_queued_prompt", parentPromptId: capturedParentPromptId, targetPromptId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      interactionId = interaction.id;
    }
    generation ??= interaction?.bindingGeneration ?? null;
    if (!interactionId || !bindingId || generation === null || !interaction?.parentPromptId || !interaction.targetPromptId) return interactionToast("warning", "转换入口已失效，原消息仍在队列中。");
    const active = this.options.activeTurn(bindingId);
    if (!active || active.promptId !== interaction.parentPromptId) return interactionToast("warning", "当前任务已结束，原消息仍按原顺序排队。");
    try {
      if (!await this.options.isSteerable(active)) return interactionToast("warning", "TraeX 已结束当前执行，原消息仍按原顺序排队。");
    } catch {
      return interactionToast("warning", "暂时无法确认 TraeX 状态，原消息仍按原顺序排队。");
    }
    const result = this.options.store.convertQueuedPromptToSteering({ interactionId, actorOpenId: action.operatorOpenId, bindingId, bindingGeneration: generation, parentPromptId: interaction.parentPromptId, targetPromptId: interaction.targetPromptId, now: new Date().toISOString() });
    if (result.outcome === "converted") { this.options.wakeSteering(bindingId, interaction.parentPromptId); return interactionToast("success", "已改为立即补充。"); }
    if (result.outcome === "duplicate") return interactionToast("success", "这条消息已转换。");
    return interactionToast(result.outcome === "unauthorized" ? "error" : "warning", result.outcome === "unauthorized" ? "这项操作不属于当前操作者。" : "当前任务已结束，原消息仍按原顺序排队。");
  }

  private enqueueFailedSteering(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const bindingId = stringValue(value.bindingId); const generation = numberValue(value.bindingGeneration); const sourcePromptId = stringValue(value.sourcePromptId);
    const binding = bindingId ? this.options.store.getBinding(bindingId) : null;
    const source = sourcePromptId ? this.options.store.getPrompt(sourcePromptId) : null;
    const sourceView = sourcePromptId ? this.options.store.loadRunCard(sourcePromptId) : null;
    if (!bindingId || generation === null || !sourcePromptId || !binding || !binding.rootMessageId || !source || !sourceView) return interactionToast("warning", "排队入口已失效，请刷新后重试。");
    if (source.actorOpenId !== action.operatorOpenId) return interactionToast("error", "这项操作不属于当前操作者。");
    const eligible = binding.chatId === action.chatId && binding.generation === generation && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached"
      && source.bindingId === bindingId && source.state === "failed" && source.dispatchKind === "steering" && source.steeringOrigin === "automatic"
      && sourceView.bindingId === bindingId && sourceView.bindingGeneration === generation && sourceView.steeringOrigin === "automatic" && sourceView.steeringFailureKind === "rejected";
    if (!eligible) return interactionToast("warning", "排队入口已失效，请刷新后重试。");
    const interactionId = `failed-steering:${action.messageId}:${sourcePromptId}`;
    let interaction = this.options.store.getCardInteraction(interactionId);
    if (!interaction) interaction = this.options.store.createCardInteraction({ id: interactionId, bindingId, bindingGeneration: generation, actorOpenId: action.operatorOpenId, actionKind: "enqueue_failed_steering", parentPromptId: null, targetPromptId: sourcePromptId, expiresAt: "9999-12-31T23:59:59.999Z" });
    const now = new Date().toISOString();
    const newPromptId = randomUUID();
    const view = createQueuedRunCard({ promptId: newPromptId, bindingId, bindingGeneration: generation, title: sourceView.title, workspaceId: sourceView.workspaceId, spaceName: sourceView.spaceName, paneId: binding.paneId, requestText: source.body, queuePosition: 1, occurredAt: now });
    const result = this.options.store.convertFailedSteeringToTurn({ interactionId: interaction.id, actorOpenId: action.operatorOpenId, bindingId, bindingGeneration: generation, sourcePromptId, newPromptId, newLarkMessageId: `card:${interaction.id}`, now, view, rootMessageId: binding.rootMessageId, answerCardFor: renderRequestAnswerCard });
    if (result.outcome === "converted") {
      this.options.logger.info({ event: "failed-auto-steering-converted", bindingId, sourcePromptId, promptId: result.prompt!.id, outcome: "converted" }, "queued rejected automatic steering as a new task");
      this.options.wakePrompt(bindingId);
      return interactionToast("success", "已作为新任务排队。");
    }
    if (result.outcome === "duplicate") return interactionToast("success", "已作为新任务排队。");
    this.options.logger.warn({ event: "failed-auto-steering-conversion-rejected", bindingId, sourcePromptId, reason: result.outcome, outcome: "rejected" }, "rejected failed automatic steering conversion");
    return interactionToast(result.outcome === "unauthorized" ? "error" : "warning", result.outcome === "unauthorized" ? "这项操作不属于当前操作者。" : "排队入口已失效，请刷新后重试。");
  }

  private openMoreActions(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return interactionToast("warning", "会话状态已变化，请刷新后重试。");
    const creator = binding.creatorOpenId === action.operatorOpenId;
    const interaction = creator ? this.options.store.createCardInteraction({ id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation, actorOpenId: action.operatorOpenId, actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }) : null;
    return { card: renderMoreActionsCard({ bindingId: binding.id, bindingGeneration: binding.generation, ...(interaction ? { interactionId: interaction.id } : {}), creator, lifecycle: binding.lifecycle, attachment: binding.attachment }) };
  }

  private openRename(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, true);
    const interaction = stringValue(value.interactionId);
    return binding && interaction ? { card: renderRenameInputCard({ interactionId: interaction, bindingId: binding.id, bindingGeneration: binding.generation }) } : interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private viewQueue(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: renderQueueSummaryCard({ queued: this.options.store.countPendingPrompts(binding.id) }) };
  }

  private viewRecovery(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, false);
    if (!binding) return interactionToast("warning", "会话状态已变化，请刷新后重试。");
    return { card: renderInteractionGuidanceCard({ kind: "recovery", message: this.options.store.loadTopicView(binding.id)?.notice ?? null }) };
  }

  private openReattach(action: IncomingLarkCardAction, value: Record<string, unknown>): LarkCardActionResult {
    const binding = this.freshBinding(action, value, true); const interaction = stringValue(value.interactionId);
    return binding && interaction ? { card: renderReattachInputCard({ interactionId: interaction, bindingId: binding.id, bindingGeneration: binding.generation }) } : interactionToast("error", "只有会话创建者可以执行此操作。");
  }

  private async sessionControl(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const binding = this.freshBinding(action, value, value.action !== "session_status");
    if (!binding) return interactionToast("error", "操作无权限，或会话状态已变化。");
    if (value.action === "submit_rename" && !action.formValues?.title?.trim()) return interactionToast("warning", "请输入新标题。");
    if (value.action === "submit_reattach" && !action.formValues?.pane_id?.trim()) return interactionToast("warning", "请输入 Pane ID。");
    if (value.action !== "session_status") {
      const interactionId = stringValue(value.interactionId);
      if (!interactionId) return interactionToast("error", "操作入口已失效。");
      const consumed = this.options.store.consumeCardInteraction({ id: interactionId, actorOpenId: action.operatorOpenId, bindingId: binding.id, bindingGeneration: binding.generation, now: new Date().toISOString(), resultCode: String(value.action) });
      if (consumed.outcome === "duplicate") return interactionToast("success", "这项操作已处理。");
      if (consumed.outcome !== "consumed") return interactionToast("error", "操作入口已失效或无权限。");
    }
    const message = syntheticMessage(action, binding, String(value.action));
    let accepted = true;
    switch (value.action) {
      case "session_status": await this.options.sessionAdministration.emitStatus(binding); break;
      case "session_stop": accepted = await this.options.paneControl.stop(message, binding); break;
      case "session_model": accepted = await this.options.modelSelection.runModel(message, binding, null); break;
      case "session_reset": accepted = await this.options.provisioning.reset(message, binding, null); break;
      case "session_archive": accepted = await this.options.sessionAdministration.archive(message, binding); break;
      case "session_resume": accepted = await this.options.sessionAdministration.resume(message, binding); break;
      case "session_replace": await this.options.provisioning.replace(binding, action.operatorOpenId); break;
      case "session_pane_close": accepted = await this.options.paneClosure.requestPaneClose(message, binding); break;
      case "submit_rename": {
        const title = action.formValues!.title!.trim();
        accepted = await this.options.sessionAdministration.rename(message, binding, title); break;
      }
      case "submit_reattach": {
        const paneId = action.formValues!.pane_id!.trim();
        await this.options.provisioning.reattach(binding, paneId, action.operatorOpenId); break;
      }
      default: return interactionToast("warning", "未知操作。");
    }
    return accepted ? interactionToast("success", value.action === "session_pane_close" ? "已发送 Pane 关闭确认卡。" : "操作已受理。") : interactionToast("warning", "当前状态不允许执行此操作。");
  }

  private freshBinding(action: IncomingLarkCardAction, value: Record<string, unknown>, creatorOnly: boolean) {
    const bindingId = stringValue(value.bindingId); const generation = numberValue(value.bindingGeneration);
    const binding = bindingId ? this.options.store.getBinding(bindingId) : null;
    if (!binding || binding.chatId !== action.chatId || (generation !== null && binding.generation !== generation)) return null;
    if (creatorOnly && binding.creatorOpenId !== action.operatorOpenId) return null;
    return binding;
  }
}

function syntheticMessage(action: IncomingLarkCardAction, binding: NonNullable<ReturnType<BindingStorePort["getBinding"]>>, name: string): IncomingLarkMessage {
  return { eventId: `card:${action.messageId}:${name}`, messageId: `card:${action.messageId}:${name}`, chatId: action.chatId, topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: action.operatorOpenId, text: name, mentionsBot: true, isRootMessage: false };
}

function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null; }
