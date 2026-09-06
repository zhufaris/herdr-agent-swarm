import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";

export type WorkerTaskReplyIntent = "steer" | "followup" | "reject";

export interface WorkerTaskInteraction {
  replyIntent: WorkerTaskReplyIntent;
  actionLabel: string | null;
  guidance: string;
  canInterrupt: boolean;
}

export function workerTaskInteraction(phase: WorkerTurnCardPhase): WorkerTaskInteraction {
  if (phase === "running") return { replyIntent: "steer", actionLabel: "补充当前任务", guidance: "点击下方「补充当前任务」精确发送到此 Worker turn；直接回复卡片仍会进入 Primary。", canInterrupt: true };
  if (phase === "blocked") return { replyIntent: "steer", actionLabel: "补充当前任务", guidance: "点击下方「补充当前任务」可精确发送到此 Worker turn；审批仍须在对应 Herdr Pane 完成。直接回复卡片仍会进入 Primary。", canInterrupt: false };
  if (phase === "completed" || phase === "failed" || phase === "cancelled") return { replyIntent: "followup", actionLabel: "继续这个任务", guidance: "点击下方「继续这个任务」创建带父任务关系的 FIFO 后续任务；直接回复卡片仍会进入 Primary。", canInterrupt: false };
  if (phase === "dispatch-uncertain") return { replyIntent: "reject", actionLabel: null, guidance: "任务投递状态无法确认，请求可能已到达 Worker。为避免重复执行，请先在对应 Herdr Pane 核实；这里不会重试或追加。", canInterrupt: false };
  if (phase === "queued") return { replyIntent: "reject", actionLabel: null, guidance: "任务仍在排队、尚未开始，暂不能追加；可等待调度，或从 Worker Main 发起独立新任务。", canInterrupt: false };
  return { replyIntent: "reject", actionLabel: null, guidance: "Worker 正在准备任务，待进入运行状态后可补充要求。", canInterrupt: false };
}
