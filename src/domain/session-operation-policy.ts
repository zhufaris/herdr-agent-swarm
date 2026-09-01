import type { Binding, SessionOperationKind } from "./types.js";

export const UNSUPPORTED_RUNTIME_MODEL_MESSAGE = "运行中的 Agent 不支持远程切换模型。请在创建 Agent 时选择模型，或显式替换 Agent 后使用新模型。";

export function sessionOperationRejection(binding: Binding, kind: SessionOperationKind): string | null {
  if (kind === "model") return UNSUPPORTED_RUNTIME_MODEL_MESSAGE;
  if (kind === "archive") return binding.lifecycle === "active" ? null : "Only an active Session can be archived";
  if (kind === "resume") return binding.lifecycle === "archived" && Boolean(binding.paneId) ? null : "Only an archived Session with a retained Pane can be resumed";
  if (kind === "reattach" || kind === "replace") return binding.lifecycle === "active" && binding.attachment === "orphaned" ? null : "Pane recovery requires an active orphaned Session";
  const validAttachment = kind === "pane_close" ? binding.attachment === "attached" : binding.attachment !== "orphaned";
  const activePane = binding.lifecycle === "active" && binding.state === "active" && validAttachment && Boolean(binding.paneId);
  return activePane ? null : `${kind} requires an active Session with a Pane`;
}
