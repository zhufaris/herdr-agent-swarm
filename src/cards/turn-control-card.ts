import type { TurnControlOperation, TurnControlState } from "../domain/turn-control.js";

const statePresentation: Record<TurnControlState, { title: string; template: string; summary: string }> = {
  accepted: { title: "Steering 已接收", template: "blue", summary: "正在核对目标 turn 并投递。" },
  dispatching: { title: "Steering 投递中", template: "blue", summary: "正在通过 TraeX native steering 投递。" },
  delivered: { title: "Steering 已送达", template: "green", summary: "指令已注入目标 turn。" },
  rejected: { title: "Steering 未送达", template: "orange", summary: "指令未注入，也不会转为普通任务。" },
  uncertain: { title: "Steering 状态无法确认", template: "orange", summary: "投递可能已发生，系统不会自动重放。请在 Herdr 中确认。" }
};

export function renderTurnControlResultCard(operation: TurnControlOperation): object {
  const presentation = statePresentation[operation.state];
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
