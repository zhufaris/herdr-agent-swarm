export const instanceCardActionNames = [
  "card_target_open",
  "instance_create_form",
  "instance_create_submit",
  "instance_open",
  "instance_turn_open",
  "instance_set_target",
  "instance_start",
  "instance_stop",
  "instance_interrupt",
  "instance_steer_form",
  "instance_steer_submit",
  "instance_plan_removal",
  "instance_confirm_removal",
  "worker_new_task_form",
  "worker_new_task_submit",
  "worker_task_instruction_form",
  "worker_task_instruction_submit",
  "worker_task_interrupt",
] as const;

export const sessionCardActionNames = [
  "open_more_actions",
  "view_queue",
  "view_recovery",
  "create_new_task",
  "open_rename",
  "open_reattach",
  "submit_rename",
  "submit_reattach",
  "session_status",
  "session_stop",
  "session_model",
  "session_reset",
  "session_archive",
  "session_replace",
  "session_resume",
  "session_pane_close",
] as const;

export const retiredCardActionNames = [
  "open_supplement",
  "submit_supplement",
  "convert_queued_prompt",
  "enqueue_failed_steering",
] as const;

type InstanceCardActionName = typeof instanceCardActionNames[number];
type SessionCardActionName = typeof sessionCardActionNames[number];
export type RetiredCardActionName = typeof retiredCardActionNames[number];
type CardValue<Action extends string> = Record<string, unknown> & { action: Action };

export type CardActionCommand =
  | { kind: "instance"; value: CardValue<InstanceCardActionName> }
  | { kind: "session"; value: CardValue<SessionCardActionName> }
  | { kind: "model"; bindingId: string; model: string }
  | { kind: "model-mode"; bindingId: string; operationId: string; mode: string }
  | { kind: "open-thread"; bindingId: string }
  | { kind: "dead-letter"; decision: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string }
  | { kind: "project-selection"; selectionId: string; projectId: string }
  | { kind: "pane-claim"; projectId: string; workspaceId: string; paneId: string }
  | { kind: "retired"; action: RetiredCardActionName }
  | { kind: "unknown" };

const instanceActions = new Set<string>(instanceCardActionNames);
const sessionActions = new Set<string>(sessionCardActionNames);
const retiredActions = new Set<string>(retiredCardActionNames);
const modelPattern = /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i;

export function parseCardActionCommand(value: unknown, option?: string | null): CardActionCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unknown" };
  const item = value as Record<string, unknown>;
  const action = typeof item.action === "string" ? item.action : null;
  if (!action) return { kind: "unknown" };
  if (instanceActions.has(action)) return { kind: "instance", value: item as CardValue<InstanceCardActionName> };
  if (sessionActions.has(action)) return { kind: "session", value: item as CardValue<SessionCardActionName> };
  if (retiredActions.has(action)) return { kind: "retired", action: action as RetiredCardActionName };
  if (action === "select_model") return typeof item.bindingId === "string" && typeof option === "string" && modelPattern.test(option)
    ? { kind: "model", bindingId: item.bindingId, model: option } : { kind: "unknown" };
  if (action === "select_model_mode") return typeof item.bindingId === "string" && typeof item.operationId === "string" && typeof option === "string" && option.length > 0 && option.length <= 128
    ? { kind: "model-mode", bindingId: item.bindingId, operationId: item.operationId, mode: option } : { kind: "unknown" };
  if (action === "open_project_thread") return typeof item.bindingId === "string" ? { kind: "open-thread", bindingId: item.bindingId } : { kind: "unknown" };
  if (action === "retry_dead_letter" || action === "dismiss_dead_letter") return typeof item.replyId === "string" ? { kind: "dead-letter", decision: action, replyId: item.replyId } : { kind: "unknown" };
  if (action === "select_project") return typeof item.selectionId === "string" && typeof item.projectId === "string" ? { kind: "project-selection", selectionId: item.selectionId, projectId: item.projectId } : { kind: "unknown" };
  if (action === "claim_pane") return typeof item.projectId === "string" && typeof item.workspaceId === "string" && typeof item.paneId === "string" ? { kind: "pane-claim", projectId: item.projectId, workspaceId: item.workspaceId, paneId: item.paneId } : { kind: "unknown" };
  return { kind: "unknown" };
}
