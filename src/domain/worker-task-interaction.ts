import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";

export type WorkerTaskReplyIntent = "steer" | "followup" | "reject";

export interface WorkerTaskInteraction {
  replyIntent: WorkerTaskReplyIntent;
  actionLabel: string | null;
  guidance: string;
  canInterrupt: boolean;
}

export function workerTaskInteraction(phase: WorkerTurnCardPhase): WorkerTaskInteraction {
  if (phase === "running") return { replyIntent: "steer", actionLabel: "补充当前任务", guidance: "回复此 Task Card 并 @Bot，可将要求精确补充到当前任务。", canInterrupt: true };
  if (phase === "blocked") return { replyIntent: "reject", actionLabel: null, guidance: "Worker 正等待 Herdr 中的本地处理；请前往对应 Pane 完成审批或回答问题。", canInterrupt: false };
  if (phase === "completed" || phase === "failed" || phase === "cancelled") return { replyIntent: "followup", actionLabel: "继续这个任务", guidance: "回复此 Task Card 并 @Bot，将创建一条带父任务关系的 FIFO 后续任务。", canInterrupt: false };
  if (phase === "dispatch-uncertain") return { replyIntent: "reject", actionLabel: null, guidance: "任务投递状态无法确认，请求可能已到达 Worker。为避免重复执行，请先在对应 Herdr Pane 核实；这里不会重试或追加。", canInterrupt: false };
  if (phase === "queued") return { replyIntent: "reject", actionLabel: null, guidance: "任务仍在排队、尚未开始，暂不能追加；可等待调度，或从 Worker Main 发起独立新任务。", canInterrupt: false };
  return { replyIntent: "reject", actionLabel: null, guidance: "Worker 正在准备任务，待进入运行状态后可补充要求。", canInterrupt: false };
}
