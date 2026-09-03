export function renderPaneCloseConfirmationCard(input: { spaceName: string; paneId: string; agentState: string; code: string; expiresAt: string }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `确认关闭 Pane ${input.paneId}` } },
    header: { title: { tag: "plain_text", content: "⚠ 确认关闭 Herdr Pane" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: [
      `**Space**  ${input.spaceName}`,
      `**Pane**  \`${input.paneId}\``,
      `**状态**  \`${input.agentState}\``, "",
      "此操作会关闭 Pane 并终止其中的 TraeX。确认码 60 秒内有效：",
      `\`/swarm pane close confirm ${input.code}\``,
      `有效期至：${input.expiresAt}`
    ].join("\n") }] }
  };
}

export function renderPaneCloseResultCard(input: { paneId: string }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `Pane ${input.paneId} 已关闭` } },
    header: { title: { tag: "plain_text", content: "✓ Herdr Pane 已关闭" }, template: "green" },
    body: { elements: [{ tag: "markdown", content: `Pane \`${input.paneId}\` 已关闭并完成消失验证。当前飞书话题已归档。` }] }
  };
}

export function renderPaneRetentionWarningCard(input: { paneId: string; warningAt: string; closeAt: string }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `Pane ${input.paneId} 即将自动关闭` } },
    header: { title: { tag: "plain_text", content: "⚠ Pane 长期闲置提醒" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: [
      `Pane \`${input.paneId}\` 已连续闲置超过保留阈值。`,
      `自动关闭宽限期开始于：${input.warningAt}`,
      `预计自动关闭时间：${input.closeAt}`,
      "如需保留，请在此话题发送新消息或手动管理该 Pane。"
    ].join("\n\n") }] }
  };
}
