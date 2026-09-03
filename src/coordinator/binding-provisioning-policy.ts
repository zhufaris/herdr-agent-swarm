import type { ProvisioningCheckpoint } from "../domain/pane-thread-lifecycle.js";

export type SelectedCheckpointDecision = "create_pane" | "manual_attach" | "continue";
export type PaneCreatedCheckpointDecision = "start_runtime" | "replace_pane" | "reject_missing_capability" | "continue";

/**
 * Recovery must never guess whether a previously selected request created a
 * pane. Creation is safe only on the original request path; recovery pauses
 * for a human-verified attach instead.
 */
export function decideSelectedCheckpoint(checkpoint: ProvisioningCheckpoint, allowPaneCreation: boolean): SelectedCheckpointDecision {
  if (checkpoint !== "selected") return "continue";
  return allowPaneCreation ? "create_pane" : "manual_attach";
}

/**
 * Determines the only safe next action at a pane-created checkpoint. A
 * capability is generation-scoped, and a running legacy process without a
 * ready composer is replaced rather than reused.
 */
export function decidePaneCreatedCheckpoint(input: {
  checkpoint: ProvisioningCheckpoint;
  hasPrimaryToolCapability: boolean;
  traexProcess: boolean;
  composerReady: boolean;
}): PaneCreatedCheckpointDecision {
  if (input.checkpoint !== "pane_created") return "continue";
  if (!input.hasPrimaryToolCapability) return "reject_missing_capability";
  if (input.traexProcess && !input.composerReady) return "replace_pane";
  return "start_runtime";
}

export function provisioningRecoveryMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("/swarm attach")
    ? `创建结果无法自动确认。请先检查对应 Space：若 Pane 已存在，发送 \`/swarm attach <space> <pane>\`；若不存在，再发送 \`/swarm new\`。${detail}`
    : `创建已停在可恢复检查点，bridge 会安全重试。${detail}`;
}
