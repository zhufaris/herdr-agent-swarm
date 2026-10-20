import type { OrchestratorClearOperation } from "../domain/orchestrator-clear.js";

export function renderOrchestratorClearResultCard(operation: OrchestratorClearOperation): object {
  const successful = operation.state === "succeeded";
  const title = successful ? "Orchestrator 上下文已清空" : operation.state === "partial" ? "Orchestrator 上下文已清空，部分卡片撤回失败" : "Orchestrator 上下文清理未完成";
  const counts = `已撤回 ${operation.withdrawnCount}，已不存在 ${operation.alreadyAbsentCount}，失败 ${operation.failedCount}`;
  const detail = operation.state === "succeeded" || operation.state === "partial"
    ? `TraeX 已切换到新上下文。${counts}。Pane ID、token、名称、位置、Thread 和 Workers 均保持不变。`
    : `未清空 TraeX 上下文，也未撤回 Answer Cards。${operation.detail ?? "请稍后重试。"}`;
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: successful ? "green" : operation.state === "partial" ? "orange" : "red" },
    body: { elements: [{ tag: "markdown", content: detail }] }
  };
}
