import type { TurnControlOperation, TurnControlState } from "../domain/turn-control.js";

const steerPresentation: Record<TurnControlState, { title: string; template: string; summary: string }> = {
  accepted: { title: "Steering 已接收", template: "blue", summary: "正在核对目标 turn 并投递。" },
  dispatching: { title: "Steering 投递中", template: "blue", summary: "正在通过 TraeX native steering 投递。" },
  delivered: { title: "Steering 已送达", template: "green", summary: "指令已注入目标 turn。" },
  rejected: { title: "Steering 未送达", template: "orange", summary: "指令未注入，也不会转为普通任务。" },
  uncertain: { title: "Steering 状态无法确认", template: "orange", summary: "投递可能已发生，系统不会自动重放。请在 Herdr 中确认。" }
};
const interruptPresentation: Record<TurnControlState, { title: string; template: string; summary: string }> = {
  accepted: { title: "停止请求已接收", template: "blue", summary: "正在核对目标 turn。" },
  dispatching: { title: "正在发送中断", template: "blue", summary: "正在通过 Herdr native control 中断目标 turn。" },
  delivered: { title: "中断已发送", template: "green", summary: "中断请求已发送，等待 Herdr 的 authoritative observation 确认 turn 终止。" },
  rejected: { title: "中断未发送", template: "orange", summary: "目标 turn 已变化或不允许远程停止。" },
  uncertain: { title: "中断状态无法确认", template: "orange", summary: "中断可能已发送，系统不会自动重试。请在 Herdr 中确认。" }
};

export function renderTurnControlResultCard(operation: TurnControlOperation): object {
  const presentation = (operation.kind === "interrupt" ? interruptPresentation : steerPresentation)[operation.state];
  const target = operation.target.owner.kind === "binding" ? "Primary" : "Worker";
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: presentation.title }, template: presentation.template },
    body: { elements: [
      { tag: "markdown", content: presentation.summary },
      { tag: "markdown", content: `**目标** ${target} · turn \`${shortId(operation.target.logicalTurnId)}\`\n**状态** ${operation.state}` }
    ] }
  };
}

function shortId(value: string): string { return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`; }
