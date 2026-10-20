import { callbackButton } from "./cardkit-button.js";
import { actionRow } from "./card-style.js";

/** Fixed group-root entry card. Actions deliberately delegate to existing workflows. */
export function renderShortcutPanelCard(): object {
  const navigation = actionRow([
    callbackButton("🧭 活跃会话", { action: "shortcut_panes" }, "primary"),
    callbackButton("📋 会话与队列", { action: "shortcut_sessions" }, "default")
  ]);
  const startAndHelp = actionRow([
    callbackButton("➕ 新建 Primary", { action: "shortcut_new_primary" }, "primary"),
    callbackButton("🧠 选择模型", { action: "shortcut_model" }, "default"),
    callbackButton("❔ 帮助", { action: "shortcut_help" }, "default")
  ]);
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr Agent Swarm 快捷入口" } },
    header: { title: { tag: "plain_text", content: "🤝 Herdr Agent Swarm" }, subtitle: { tag: "plain_text", content: "群内快捷入口 · 所有高风险操作仍需要确认" }, template: "blue" },
    body: { elements: [
      { tag: "markdown", content: "**会话导航**\n快速查看正在活动的 Primary 会话，并将对应 Thread 发送到群底部。" },
      ...(navigation ? [navigation] : []),
      { tag: "hr" },
      { tag: "markdown", content: "**开始与帮助**\n新建会话继续使用既有项目选择流程；模型选择先定位到具体会话。" },
      ...(startAndHelp ? [startAndHelp] : []),
      { tag: "markdown", content: "也可直接发送 `/swarm panes`、`/swarm projects` 或 `/swarm help`。" }
    ] }
  };
}
