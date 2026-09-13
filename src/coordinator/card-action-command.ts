import type { CardAggregateKind } from "../domain/card-target-ref.js";
import type { SessionOperationKind } from "../domain/types.js";

export const instanceCardActionNames = [
  "card_target_open", "instance_create_form", "instance_create_submit", "primary_worker_create_submit", "instance_open", "instance_turn_open",
  "instance_set_target", "instance_start", "instance_stop", "instance_interrupt", "instance_steer_form",
  "instance_steer_submit", "instance_plan_removal", "instance_confirm_removal", "worker_new_task_form",
  "worker_new_task_submit", "worker_task_instruction_form", "worker_task_instruction_submit", "worker_task_interrupt", "worker_thread_send",
] as const;

export const sessionCardActionNames = [
  "open_more_actions", "view_queue", "view_recovery", "create_new_task", "open_rename", "open_reattach",
  "submit_rename", "submit_reattach", "session_status", "session_stop", "session_model", "session_reset",
  "session_archive", "session_replace", "session_resume", "session_pane_close", "primary_continue_form", "primary_continue_submit",
] as const;
export const paneDirectoryCardActionNames = ["pane_card_send"] as const;

export const retiredCardActionNames = ["open_supplement", "submit_supplement", "convert_queued_prompt", "enqueue_failed_steering"] as const;
export type RetiredCardActionName = typeof retiredCardActionNames[number];

export interface BindingCardContext { bindingId?: string; bindingGeneration?: number; conversationKey: string | null }
interface SessionBindingContext { bindingId: string; bindingGeneration: number | null }
interface InstanceIdentity extends BindingCardContext { instanceId: string; generation: number }
interface WorkerMainIdentity { instanceId: string; generation: number; workerSessionGeneration: number; sourceCardMessageId: string }
interface WorkerTaskIdentity extends WorkerMainIdentity { turnId: string }
interface WorkerThreadIdentity extends InstanceIdentity { workerSessionGeneration: number }
type ActionVariants<Action extends string, Fields = object> = Action extends string ? { kind: "session"; action: Action } & Fields : never;
type InstanceActionVariants<Action extends string, Fields> = Action extends string ? { kind: "instance"; action: Action } & Fields : never;

export type SessionCardActionCommand =
  | ActionVariants<"open_more_actions" | "view_queue" | "view_recovery", SessionBindingContext>
  | { kind: "session"; action: "create_new_task" }
  | ActionVariants<"open_rename" | "open_reattach", SessionBindingContext & { interactionId: string }>
  | ({ kind: "session"; action: "session_status" } & SessionBindingContext)
  | ({ kind: "session"; action: "session_model"; interactionId: string } & SessionBindingContext)
  | ActionVariants<"session_stop" | "session_reset" | "session_archive" | "session_replace" | "session_resume" | "session_pane_close", SessionBindingContext & { interactionId: string; operation: Exclude<SessionOperationKind, "model" | "rename" | "reattach"> }>
  | ({ kind: "session"; action: "submit_rename"; interactionId: string; operation: "rename" } & SessionBindingContext)
  | ({ kind: "session"; action: "submit_reattach"; interactionId: string; operation: "reattach" } & SessionBindingContext)
  | ({ kind: "session"; action: "primary_continue_form"; parentPromptId: string; sourceAnswerMessageId: string } & SessionBindingContext)
  | ({ kind: "session"; action: "primary_continue_submit"; interactionId: string; parentPromptId: string; sourceAnswerMessageId: string; requestedBy: string } & SessionBindingContext);

export type InstanceCardActionCommand =
  | ({ kind: "instance"; action: "card_target_open"; aggregateKind: CardAggregateKind; aggregateId: string; generation: number; messageId: string } & BindingCardContext)
  | ({ kind: "instance"; action: "instance_create_form"; projectId?: string } & BindingCardContext)
  | ({ kind: "instance"; action: "instance_create_submit"; projectId: string; requestedBy: string } & BindingCardContext)
  | ({ kind: "instance"; action: "primary_worker_create_submit" } & BindingCardContext & { bindingId: string; bindingGeneration: number })
  | InstanceActionVariants<"instance_open" | "instance_set_target" | "instance_start" | "instance_stop" | "instance_interrupt" | "instance_steer_form" | "instance_plan_removal", InstanceIdentity>
  | ({ kind: "instance"; action: "instance_turn_open"; turnId: string } & InstanceIdentity)
  | ({ kind: "instance"; action: "instance_steer_submit"; requestedBy: string } & InstanceIdentity)
  | ({ kind: "instance"; action: "instance_confirm_removal"; planId: string; requestedBy: string } & InstanceIdentity)
  | ({ kind: "instance"; action: "worker_thread_send" } & WorkerThreadIdentity)
  | ({ kind: "instance"; action: "worker_new_task_form" } & WorkerMainIdentity)
  | ({ kind: "instance"; action: "worker_new_task_submit"; interactionId: string; requestedBy: string } & WorkerMainIdentity)
  | ({ kind: "instance"; action: "worker_task_instruction_form" | "worker_task_interrupt" } & WorkerTaskIdentity)
  | ({ kind: "instance"; action: "worker_task_instruction_submit"; interactionId: string; requestedBy: string; intent: "steer" | "followup" } & WorkerTaskIdentity);

export type CardActionCommand = InstanceCardActionCommand | SessionCardActionCommand
  | { kind: "pane-directory"; action: "pane_card_send"; bindingId: string; bindingGeneration: number; paneId: string; sourceMainMessageId: string }
  | { kind: "model"; bindingId: string; model: string }
  | { kind: "model-mode"; bindingId: string; operationId: string; mode: string }
  | { kind: "open-thread"; bindingId: string }
  | { kind: "dead-letter"; decision: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string }
  | { kind: "project-selection"; selectionId: string; projectId: string }
  | { kind: "pane-claim"; projectId: string; workspaceId: string; paneId: string }
  | { kind: "retired"; action: RetiredCardActionName }
  | { kind: "unknown" };

const retiredActions = new Set<string>(retiredCardActionNames);
const modelPattern = /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i;
const aggregateKinds = new Set<CardAggregateKind>(["primary-session", "primary-turn", "worker-session", "worker-turn"]);

export function parseCardActionCommand(value: unknown, option?: string | null): CardActionCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const item = value as Record<string, unknown>;
  const action = string(item.action);
  if (!action) return unknown();
  if (retiredActions.has(action)) return { kind: "retired", action: action as RetiredCardActionName };
  const session = parseSession(action, item);
  if (session) return session;
  if (action === "pane_card_send") { const bindingId = string(item.bindingId); const bindingGeneration = integer(item.bindingGeneration); const paneId = string(item.paneId); const sourceMainMessageId = string(item.sourceMainMessageId); return bindingId && bindingGeneration !== null && paneId && sourceMainMessageId ? { kind: "pane-directory", action, bindingId, bindingGeneration, paneId, sourceMainMessageId } : unknown(); }
  const instance = parseInstance(action, item);
  if (instance) return instance;
  if (action === "select_model") return string(item.bindingId) && typeof option === "string" && modelPattern.test(option) ? { kind: "model", bindingId: item.bindingId as string, model: option } : unknown();
  if (action === "select_model_mode") return string(item.bindingId) && string(item.operationId) && typeof option === "string" && option.length > 0 && option.length <= 128 ? { kind: "model-mode", bindingId: item.bindingId as string, operationId: item.operationId as string, mode: option } : unknown();
  if (action === "open_project_thread") { const bindingId = string(item.bindingId); return bindingId ? { kind: "open-thread", bindingId } : unknown(); }
  if (action === "retry_dead_letter" || action === "dismiss_dead_letter") { const replyId = string(item.replyId); return replyId ? { kind: "dead-letter", decision: action, replyId } : unknown(); }
  if (action === "select_project") { const selectionId = string(item.selectionId); const projectId = string(item.projectId); return selectionId && projectId ? { kind: "project-selection", selectionId, projectId } : unknown(); }
  if (action === "claim_pane") { const projectId = string(item.projectId); const workspaceId = string(item.workspaceId); const paneId = string(item.paneId); return projectId && workspaceId && paneId ? { kind: "pane-claim", projectId, workspaceId, paneId } : unknown(); }
  return unknown();
}

function parseSession(action: string, item: Record<string, unknown>): SessionCardActionCommand | null {
  if (action === "create_new_task") return { kind: "session", action };
  if (!(sessionCardActionNames as readonly string[]).includes(action)) return null;
  const context = sessionContext(item);
  if (!context) return null;
  if (action === "primary_continue_form") { const parentPromptId = string(item.parentPromptId); const sourceAnswerMessageId = string(item.sourceAnswerMessageId); return parentPromptId && sourceAnswerMessageId ? { kind: "session", action, parentPromptId, sourceAnswerMessageId, ...context } : null; }
  if (action === "primary_continue_submit") { const interactionId = interaction(item.interactionId); const parentPromptId = string(item.parentPromptId); const sourceAnswerMessageId = string(item.sourceAnswerMessageId); const requestedBy = string(item.requestedBy); return interactionId && parentPromptId && sourceAnswerMessageId && requestedBy ? { kind: "session", action, interactionId, parentPromptId, sourceAnswerMessageId, requestedBy, ...context } : null; }
  if (action === "open_more_actions" || action === "view_queue" || action === "view_recovery" || action === "session_status") return { kind: "session", action, ...context };
  const interactionId = interaction(item.interactionId);
  if (!interactionId) return null;
  if (action === "open_rename" || action === "open_reattach" || action === "session_model") return { kind: "session", action, interactionId, ...context };
  if (action === "submit_rename") return { kind: "session", action, interactionId, operation: "rename", ...context };
  if (action === "submit_reattach") return { kind: "session", action, interactionId, operation: "reattach", ...context };
  switch (action) {
    case "session_stop": return { kind: "session", action, interactionId, operation: "stop", ...context };
    case "session_reset": return { kind: "session", action, interactionId, operation: "reset", ...context };
    case "session_archive": return { kind: "session", action, interactionId, operation: "archive", ...context };
    case "session_replace": return { kind: "session", action, interactionId, operation: "replace", ...context };
    case "session_resume": return { kind: "session", action, interactionId, operation: "resume", ...context };
    case "session_pane_close": return { kind: "session", action, interactionId, operation: "pane_close", ...context };
    default: return null;
  }
}

function parseInstance(action: string, item: Record<string, unknown>): InstanceCardActionCommand | null {
  if (!(instanceCardActionNames as readonly string[]).includes(action)) return null;
  const binding = bindingContext(item);
  if (!binding) return null;
  if (action === "card_target_open") {
    const aggregateKind = aggregateKinds.has(item.aggregateKind as CardAggregateKind) ? item.aggregateKind as CardAggregateKind : null;
    const aggregateId = string(item.aggregateId); const generation = integer(item.generation); const messageId = string(item.messageId);
    return aggregateKind && aggregateId && generation !== null && messageId ? { kind: "instance", action, aggregateKind, aggregateId, generation, messageId, ...binding } : null;
  }
  if (action === "instance_create_form") { const projectId = optionalString(item.projectId); return projectId === undefined ? null : { kind: "instance", action, ...(projectId ? { projectId } : {}), ...binding }; }
  if (action === "instance_create_submit") { const projectId = string(item.projectId); const requestedBy = string(item.requestedBy); return projectId && requestedBy ? { kind: "instance", action, projectId, requestedBy, ...binding } : null; }
  if (action === "primary_worker_create_submit") return binding.bindingId && binding.conversationKey === `binding:${binding.bindingId}` ? { kind: "instance", action, ...binding, bindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration! } : null;
  const main = workerMainIdentity(item);
  if (action === "worker_new_task_form") return main ? { kind: "instance", action, ...main } : null;
  if (action === "worker_new_task_submit") { const interactionId = interaction(item.interactionId); const requestedBy = string(item.requestedBy); return main && interactionId && requestedBy ? { kind: "instance", action, interactionId, requestedBy, ...main } : null; }
  const task = workerTaskIdentity(item);
  if (action === "worker_task_instruction_form" || action === "worker_task_interrupt") return task ? { kind: "instance", action, ...task } : null;
  if (action === "worker_task_instruction_submit") { const interactionId = interaction(item.interactionId); const requestedBy = string(item.requestedBy); const intent = item.intent === "steer" || item.intent === "followup" ? item.intent : null; return task && interactionId && requestedBy && intent ? { kind: "instance", action, interactionId, requestedBy, intent, ...task } : null; }
  const identity = instanceIdentity(item, binding);
  if (!identity) return null;
  if (action === "worker_thread_send") { const workerSessionGeneration = integer(item.workerSessionGeneration); return workerSessionGeneration !== null ? { kind: "instance", action, workerSessionGeneration, ...identity } : null; }
  if (action === "instance_turn_open") { const turnId = string(item.turnId); return turnId ? { kind: "instance", action, turnId, ...identity } : null; }
  if (action === "instance_steer_submit") { const requestedBy = string(item.requestedBy); return requestedBy ? { kind: "instance", action, requestedBy, ...identity } : null; }
  if (action === "instance_confirm_removal") { const requestedBy = string(item.requestedBy); const planId = string(item.planId); return requestedBy && planId ? { kind: "instance", action, requestedBy, planId, ...identity } : null; }
  switch (action) {
    case "instance_open": return { kind: "instance", action, ...identity };
    case "instance_set_target": return { kind: "instance", action, ...identity };
    case "instance_start": return { kind: "instance", action, ...identity };
    case "instance_stop": return { kind: "instance", action, ...identity };
    case "instance_interrupt": return { kind: "instance", action, ...identity };
    case "instance_steer_form": return { kind: "instance", action, ...identity };
    case "instance_plan_removal": return { kind: "instance", action, ...identity };
    default: return null;
  }
}

function sessionContext(item: Record<string, unknown>): SessionBindingContext | null { const bindingId = string(item.bindingId); const bindingGeneration = optionalInteger(item.bindingGeneration); return bindingId && bindingGeneration !== undefined ? { bindingId, bindingGeneration } : null; }
function bindingContext(item: Record<string, unknown>): BindingCardContext | null {
  const bindingId = optionalString(item.bindingId); const bindingGeneration = optionalInteger(item.bindingGeneration); const conversationKey = optionalString(item.conversationKey, 200);
  if (bindingId === undefined || bindingGeneration === undefined || conversationKey === undefined || ((bindingId === null) !== (bindingGeneration === null))) return null;
  return { ...(bindingId ? { bindingId, bindingGeneration: bindingGeneration! } : {}), conversationKey };
}
function instanceIdentity(item: Record<string, unknown>, binding: BindingCardContext): InstanceIdentity | null { const instanceId = string(item.instanceId); const generation = integer(item.generation); return instanceId && generation !== null ? { instanceId, generation, ...binding } : null; }
function workerMainIdentity(item: Record<string, unknown>): WorkerMainIdentity | null { const instanceId = string(item.instanceId); const generation = integer(item.generation); const workerSessionGeneration = integer(item.workerSessionGeneration); const sourceCardMessageId = string(item.sourceCardMessageId); return instanceId && generation !== null && workerSessionGeneration !== null && sourceCardMessageId ? { instanceId, generation, workerSessionGeneration, sourceCardMessageId } : null; }
function workerTaskIdentity(item: Record<string, unknown>): WorkerTaskIdentity | null { const main = workerMainIdentity(item); const turnId = string(item.turnId); return main && turnId ? { ...main, turnId } : null; }
function string(value: unknown, max = 500): string | null { return typeof value === "string" && value.length > 0 && value.length <= max ? value : null; }
function optionalString(value: unknown, max = 500): string | null | undefined { return value === undefined ? null : string(value, max) ?? undefined; }
function integer(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null; }
function optionalInteger(value: unknown): number | null | undefined { return value === undefined ? null : integer(value) ?? undefined; }
function interaction(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function unknown(): CardActionCommand { return { kind: "unknown" }; }
