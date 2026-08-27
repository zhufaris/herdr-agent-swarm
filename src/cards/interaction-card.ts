export function renderSupplementInputCard(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "立即补充" } },
    header: { title: { tag: "plain_text", content: "立即补充当前任务" }, template: "blue" },
    body: { elements: [
      { tag: "markdown", content: "这段内容只会发送给当前正在执行的任务；任务结束后不会自动转投下一条。" },
      { tag: "form", name: "supplement_form", elements: [
        { tag: "input", name: "supplement_text", placeholder: { tag: "plain_text", content: "输入需要立即补充的内容" } },
        { tag: "button", text: { tag: "plain_text", content: "发送补充" }, type: "primary", action_type: "form_submit",
          value: { action: "submit_supplement", interactionId: input.interactionId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } }
      ] }
    ] }
  };
}

export function interactionToast(type: "success" | "warning" | "error", content: string): { toast: { type: "success" | "warning" | "error"; content: string } } {
  return { toast: { type, content } };
}

export function renderMoreActionsCard(input: { bindingId: string; bindingGeneration: number; interactionId?: string; creator: boolean; lifecycle: string; attachment: string }): object {
  const actions: object[] = [button("刷新状态", "session_status", input)];
  if (input.creator) {
    if (input.lifecycle === "active") actions.push(button("停止当前任务", "session_stop", input), button("模型", "session_model", input), button("重命名", "open_rename", input), button("重置会话", "session_reset", input), button("归档", "session_archive", input), button("关闭 Pane", "session_pane_close", input));
    if (input.lifecycle === "archived") actions.push(button("恢复会话", "session_resume", input));
    if (input.attachment === "orphaned") actions.push(button("重新连接 Pane", "open_reattach", input), button("创建替代 Pane", "session_replace", input));
  }
  return { schema: "2.0", config: { update_multi: true, summary: { content: "更多操作" } }, header: { title: { tag: "plain_text", content: "更多操作" }, template: "blue" }, body: { elements: [
    { tag: "markdown", content: input.creator ? "以下操作基于当前会话状态实时校验。" : "你可以查看状态；会话管理操作仅创建者可用。" },
    { tag: "action", actions }
  ] } };
}

export function renderRenameInputCard(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object {
  return { schema: "2.0", config: { update_multi: true, summary: { content: "重命名会话" } }, header: { title: { tag: "plain_text", content: "重命名会话" }, template: "blue" }, body: { elements: [{ tag: "form", name: "rename_form", elements: [
    { tag: "input", name: "title", placeholder: { tag: "plain_text", content: "输入新标题" } },
    { tag: "button", text: { tag: "plain_text", content: "确认重命名" }, type: "primary", action_type: "form_submit", value: { action: "submit_rename", interactionId: input.interactionId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } }
  ] }] } };
}

export function renderReattachInputCard(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object {
  return { schema: "2.0", config: { update_multi: true, summary: { content: "重新连接 Pane" } }, header: { title: { tag: "plain_text", content: "重新连接 Pane" }, template: "orange" }, body: { elements: [{ tag: "form", name: "reattach_form", elements: [
    { tag: "input", name: "pane_id", placeholder: { tag: "plain_text", content: "输入原 Pane ID" } },
    { tag: "button", text: { tag: "plain_text", content: "验证并连接" }, type: "primary", action_type: "form_submit", value: { action: "submit_reattach", interactionId: input.interactionId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } }
  ] }] } };
}

function button(content: string, action: string, input: { bindingId: string; bindingGeneration: number; interactionId?: string }): object {
  return { tag: "button", text: { tag: "plain_text", content }, value: { action, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration, ...(input.interactionId ? { interactionId: input.interactionId } : {}) } };
}
