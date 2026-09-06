import type { AgentInstance } from "../../domain/agent-instance.js";
import type { InstanceStore } from "../../domain/ports/instance.js";
import type { ApplicationPresentation } from "../../domain/ports/presentation.js";
import type { IncomingLarkCardAction, LarkCardActionResult } from "../../domain/types.js";
import { decideWorkerMainCardOwnership, decideWorkerTaskCardOwnership } from "../../domain/worker-card-ownership.js";
import { workerTaskInteraction, type WorkerTaskReplyIntent } from "../../domain/worker-task-interaction.js";
import { safeLogError } from "../../runtime/safe-error.js";
import type { InstanceMessagingWorkflow } from "../instance-messaging-workflow.js";

export class WorkerCardActions {
  constructor(private readonly options: { store: InstanceStore; messaging: InstanceMessagingWorkflow; presentation: Pick<ApplicationPresentation, "workerNewTask" | "workerTaskInstruction">; idFactory(): string }) {}

  async handleTask(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const owned = this.resolveTask(action, value);
    if (!owned) return warning("Worker Task 卡片已过期、状态已变化或不属于当前 Primary。");
    const { instance, turn, view, intent } = owned;
    if (value.action === "worker_task_instruction_form") {
      if (intent === "reject") return warning(workerTaskInteraction(view.phase).guidance);
      return { card: this.options.presentation.workerTaskInstruction({ workerName: instance.name, turnId: turn.id, intent, interactionId: this.options.idFactory(), requestedBy: action.operatorOpenId, sourceCardMessageId: view.messageId!, instanceId: instance.id, generation: instance.generation, workerSessionGeneration: instance.workerSessionGeneration }) };
    }
    if (value.action === "worker_task_interrupt") {
      if (!workerTaskInteraction(view.phase).canInterrupt) return warning("任务已不处于可停止的运行状态。");
      const result = await this.options.messaging.interrupt({ idempotencyKey: `card:${action.messageId}:interrupt:${turn.id}`, actor: actor(action), targetInstanceId: instance.id, targetTurnId: turn.id });
      return { toast: { type: result.status === "interrupted" ? "success" : "warning", content: result.status === "interrupted" ? `已停止 ${instance.name} 的当前任务。` : `停止当前任务：${result.status}` } };
    }
    if (value.action !== "worker_task_instruction_submit") return warning("未知的 Worker Task 操作。");
    if (!sameOperator(value, action)) return forbidden();
    const interactionId = validInteractionId(value.interactionId);
    if (!interactionId) return warning("操作标识无效，请重新打开表单。");
    const requestedIntent = value.intent === "steer" || value.intent === "followup" ? value.intent : null;
    if (!requestedIntent || requestedIntent !== intent) return warning("任务状态已变化，请重新打开 Task Card 后再操作。");
    const text = action.formValues?.instruction_text?.trim() ?? "";
    if (!text) return { toast: { type: "error", content: "任务要求不能为空。" } };
    try {
      if (intent === "steer") {
        const result = await this.options.messaging.steer({ idempotencyKey: `card:${interactionId}:task-steer:${turn.id}`, actor: actor(action), targetInstanceId: instance.id, targetTurnId: turn.id, text, resultTargetMessageId: action.messageId });
        return { toast: { type: result.status === "delivered" ? "success" : "warning", content: result.status === "delivered" ? `已补充到 ${instance.name} 的当前任务。` : `补充当前任务：${result.status}` } };
      }
      const submitted = await this.options.messaging.submit({ idempotencyKey: `card:${interactionId}:task-followup:${turn.id}`, actor: actor(action), projectId: turn.projectId, targetInstanceId: instance.id, content: { kind: "followup", text }, source: { messageId: action.messageId, rootMessageId: view.rootMessageId, parentTurnId: turn.id } });
      return { toast: { type: "success", content: `已创建 ${instance.name} 的后续任务，当前排队位置 ${submitted.card?.queuePosition ?? 1}。` } };
    } catch (error) { return failed(error); }
  }

  async handleNewTask(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const owned = this.resolveMain(action, value);
    if (!owned) return warning("Worker Main 卡片已过期、状态已变化或不属于当前 Primary。");
    const { instance, view } = owned;
    if (value.action === "worker_new_task_form") return { card: this.options.presentation.workerNewTask({ workerName: instance.name, interactionId: this.options.idFactory(), requestedBy: action.operatorOpenId, sourceCardMessageId: view.messageId!, instanceId: instance.id, generation: instance.generation, workerSessionGeneration: instance.workerSessionGeneration }) };
    if (value.action !== "worker_new_task_submit") return warning("未知的 Worker 新任务操作。");
    if (!sameOperator(value, action)) return forbidden();
    const interactionId = validInteractionId(value.interactionId);
    if (!interactionId) return warning("操作标识无效，请重新打开表单。");
    const text = action.formValues?.task_text?.trim() ?? "";
    if (!text) return { toast: { type: "error", content: "新任务内容不能为空。" } };
    try {
      const submitted = await this.options.messaging.submit({ idempotencyKey: `card:${interactionId}:worker-new-task:${instance.id}`, actor: actor(action), projectId: instance.projectId, targetInstanceId: instance.id, content: { kind: "turn", text }, source: { messageId: action.messageId, rootMessageId: view.messageId! } });
      return { toast: { type: "success", content: `已向 ${instance.name} 发起新任务，当前排队位置 ${submitted.card?.queuePosition ?? 1}。` } };
    } catch (error) { return failed(error); }
  }

  private resolveTask(action: IncomingLarkCardAction, value: Record<string, unknown>): { instance: AgentInstance; turn: NonNullable<ReturnType<InstanceStore["getInstanceTurn"]>>; view: NonNullable<ReturnType<InstanceStore["loadWorkerTurnCard"]>>; intent: WorkerTaskReplyIntent } | null {
    const turnId = typeof value.turnId === "string" ? value.turnId : "";
    const sourceCardMessageId = typeof value.sourceCardMessageId === "string" ? value.sourceCardMessageId : "";
    const turn = this.options.store.getInstanceTurn(turnId);
    const view = this.options.store.loadWorkerTurnCard(turnId);
    const instance = turn ? this.options.store.getAgentInstance(turn.instanceId) : null;
    const binding = instance?.parent ? this.options.store.getBinding(instance.parent.bindingId) : null;
    const decision = decideWorkerTaskCardOwnership({ chatId: action.chatId, actionMessageId: action.messageId, sourceCardMessageId, expectedInstanceGeneration: Number(value.generation), expectedWorkerSessionGeneration: Number(value.workerSessionGeneration), instance, turn, view, binding });
    return decision.allowed && turn && view && instance ? { instance, turn, view, intent: workerTaskInteraction(view.phase).replyIntent } : null;
  }

  private resolveMain(action: IncomingLarkCardAction, value: Record<string, unknown>): { instance: AgentInstance; view: NonNullable<ReturnType<InstanceStore["loadWorkerMainView"]>> } | null {
    const instanceId = typeof value.instanceId === "string" ? value.instanceId : "";
    const sessionGeneration = Number(value.workerSessionGeneration);
    const sourceCardMessageId = typeof value.sourceCardMessageId === "string" ? value.sourceCardMessageId : "";
    const instance = this.options.store.getAgentInstance(instanceId);
    const view = this.options.store.loadWorkerMainView(instanceId, sessionGeneration);
    const binding = instance?.parent ? this.options.store.getBinding(instance.parent.bindingId) : null;
    const decision = decideWorkerMainCardOwnership({ chatId: action.chatId, actionMessageId: action.messageId, sourceCardMessageId, expectedInstanceGeneration: Number(value.generation), expectedWorkerSessionGeneration: sessionGeneration, instance, view, binding });
    return decision.allowed && instance && view ? { instance, view } : null;
  }
}

function actor(action: IncomingLarkCardAction) { return { kind: "human" as const, userId: action.operatorOpenId, channel: "feishu" as const }; }
function sameOperator(value: Record<string, unknown>, action: IncomingLarkCardAction): boolean { return typeof value.requestedBy === "string" && value.requestedBy === action.operatorOpenId; }
function validInteractionId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function forbidden(): LarkCardActionResult { return { toast: { type: "error", content: "只有发起此操作的用户可以提交。" } }; }
function warning(content: string): LarkCardActionResult { return { toast: { type: "warning", content } }; }
function failed(error: unknown): LarkCardActionResult { return { toast: { type: "error", content: safeLogError(error).message } }; }
