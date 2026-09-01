import { callbackButton, formSubmitButton } from "./cardkit-button.js";

export function interactionToast(type: "success" | "warning" | "error", content: string): { toast: { type: "success" | "warning" | "error"; content: string } } {
  return { toast: { type, content } };
}

export function renderQueueSummaryCard(input: { queued: number }): object {
  const content = input.queued > 0 ? "当前有 **" + input.queued + "** 条普通消息按 FIFO 等待。" : "当前没有排队任务。";
  return { schema: "2.0", config: { update_multi: true, summary: { content: "任务队列" } }, header: { title: { tag: "plain_text", content: "任务队列" }, template: "blue" }, body: { elements: [{ tag: "markdown", content }] } };
}

export function renderInteractionGuidanceCard(input: { kind: "recovery" | "new_task"; message?: string | null }): object {
  const recovery = input.kind === "recovery";
  return { schema: "2.0", config: { update_multi: true, summary: { content: recovery ? "恢复指引" : "新建任务" } }, header: { title: { tag: "plain_text", content: recovery ? "恢复指引" : "新建任务" }, template: recovery ? "orange" : "blue" }, body: { elements: [{ tag: "markdown", content: recovery ? (input.message || "请根据当前卡片状态检查 Herdr Pane；如绑定异常，可由创建者在“更多操作”中重新连接或替换 Pane。") : "在群里发送一条新的顶层消息并 @Bot，描述任务后选择项目即可开始。" }] } };
}

export function renderMoreActionsCard(input: { bindingId: string; bindingGeneration: number; interactionId?: string; creator: boolean; lifecycle: string; attachment: string }): object {
  const actions: object[] = [button("刷新状态", "session_status", input)];
  if (input.creator) {
    if (input.attachment === "orphaned") actions.push(button("重新连接 Pane", "open_reattach", input), button("创建替代 Pane", "session_replace", input), button("归档", "session_archive", input));
    else if (input.lifecycle === "active") actions.push(button("停止当前任务", "session_stop", input), button("重命名", "open_rename", input), button("重置会话", "session_reset", input), button("归档", "session_archive", input), button("关闭 Pane", "session_pane_close", input));
    else if (input.lifecycle === "archived") actions.push(button("恢复会话", "session_resume", input));
  }
  return { schema: "2.0", config: { update_multi: true, summary: { content: "更多操作" } }, header: { title: { tag: "plain_text", content: "更多操作" }, template: "blue" }, body: { elements: [
    { tag: "markdown", content: input.creator ? "以下操作基于当前会话状态实时校验。" : "你可以查看状态；会话管理操作仅创建者可用。" },
    ...actions
  ] } };
}

export function renderRenameInputCard(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object {
  return { schema: "2.0", config: { update_multi: true, summary: { content: "重命名会话" } }, header: { title: { tag: "plain_text", content: "重命名会话" }, template: "blue" }, body: { elements: [{ tag: "form", name: "rename_form", elements: [
    { tag: "input", name: "title", placeholder: { tag: "plain_text", content: "输入新标题" } },
    formSubmitButton("确认重命名", "submit_rename", { action: "submit_rename", interactionId: input.interactionId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration }, "primary")
  ] }] } };
}

export function renderReattachInputCard(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object {
  return { schema: "2.0", config: { update_multi: true, summary: { content: "重新连接 Pane" } }, header: { title: { tag: "plain_text", content: "重新连接 Pane" }, template: "orange" }, body: { elements: [{ tag: "form", name: "reattach_form", elements: [
    { tag: "input", name: "pane_id", placeholder: { tag: "plain_text", content: "输入原 Pane ID" } },
    formSubmitButton("验证并连接", "submit_reattach", { action: "submit_reattach", interactionId: input.interactionId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration }, "primary")
  ] }] } };
}

function button(content: string, action: string, input: { bindingId: string; bindingGeneration: number; interactionId?: string }): object {
  return callbackButton(content, { action, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration, ...(input.interactionId ? { interactionId: input.interactionId } : {}) });
}
