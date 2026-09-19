import type { NaturalLanguageCommandConfirmation, NaturalLanguageCommandEnvelope } from "../domain/natural-language-command-confirmation.js";
import { actionRow } from "./card-style.js";
import { callbackButton } from "./cardkit-button.js";

export function renderNaturalLanguageCommandConfirmationCard(input: NaturalLanguageCommandConfirmation): object {
  const actions = actionRow([
    callbackButton("确认执行", { action: "natural_language_command_confirm", confirmationId: input.id }, "primary"),
    callbackButton("取消", { action: "natural_language_command_cancel", confirmationId: input.id }, "default")
  ]);
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: "Swarm 命令待确认" } },
    header: { title: { tag: "plain_text", content: "Swarm 命令待确认" }, template: "orange" },
    body: { elements: [
      { tag: "markdown", content: `**将执行**\n${describeEnvelope(input.envelope)}` },
      { tag: "markdown", content: "只会执行上面显示的白名单操作。不会开放任意终端输入、Pane 删除或远程 TraeX 审批。" },
      { tag: "markdown", content: `有效期至：${input.expiresAt}` },
      ...(actions ? [actions] : [])
    ] }
  };
}

export function renderNaturalLanguageCommandGuidanceCard(input: { title: string; message: string; examples: readonly string[]; warning?: boolean }): object {
  const examples = input.examples.slice(0, 3).map((value) => `- ${value}`).join("\n");
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: input.title } },
    header: { title: { tag: "plain_text", content: input.title }, template: input.warning ? "orange" : "blue" },
    body: { elements: [{ tag: "markdown", content: `${input.message}${examples ? `\n\n**示例**\n${examples}` : ""}` }] }
  };
}

function describeEnvelope(value: NaturalLanguageCommandEnvelope): string {
  const command = value.command;
  if (value.family === "instance") {
    if (command.kind === "to") return `向 Worker **${command.name}** 发送新任务：\n${command.text}`;
    if (command.kind === "steer_instance") return `向 Worker **${command.name}** 追加指令：\n${command.text}`;
    if (command.kind === "stop_instance") return `停止 Worker **${command.name}** 的当前任务`;
    return `Worker 操作：${command.kind}`;
  }
  if (command.kind === "new") return `创建新的 Primary 任务/会话${command.title ? `：${command.title}` : ""}`;
  if (command.kind === "worker_create") return `创建 Worker **${command.name}** · ${command.agentKind}${command.model ? ` · ${command.model}` : ""}${command.start ? " · 立即启动" : ""}`;
  if (command.kind === "steer") return `向当前 Primary 任务追加指令：\n${command.text}`;
  if (command.kind === "rename") return `将当前会话重命名为 **${command.title}**`;
  if (command.kind === "model") return `将当前会话模型切换为 **${command.name ?? "默认模型"}**`;
  if (command.kind === "attach") return `连接 Pane **${command.paneId}** 到 Space **${command.spaceName}**`;
  if (command.kind === "reattach") return `重新连接 Pane **${command.paneId}**`;
  if (command.kind === "pane_close_confirm") return `提交 Pane 关闭确认码 **${command.code}**`;
  return `Swarm 操作：${command.kind}`;
}
