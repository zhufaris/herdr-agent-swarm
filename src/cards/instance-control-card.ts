import type { AgentInstance, InstanceRemovalPlan, WorkspaceLease } from "../domain/agent-instance.js";
import { callbackButton, formSubmitButton } from "./cardkit-button.js";

export function renderInstanceCreateCard(input: { projectId: string; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object {
  return card("创建 Worker", "blue", [{ tag: "form", name: "instance_create_form", elements: [
    { tag: "input", name: "name", input_type: "text", required: true, placeholder: { tag: "plain_text", content: "实例名，例如 reviewer" } },
    select("agent_kind", "选择底层 Agent", [["TraeX", "traex"], ["Codex", "codex"], ["Claude Code", "claude-code"], ["Pi", "pi"]]),
    { tag: "input", name: "model", input_type: "text", placeholder: { tag: "plain_text", content: "可选模型名" } },
    select("start", "创建后是否启动", [["暂不启动", "false"], ["立即启动", "true"]]),
    formSubmitButton("创建 Worker", "instance_create_submit", { action: "instance_create_submit", projectId: input.projectId, requestedBy: input.requestedBy, ...(input.bindingId ? { bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } : {}), ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}) }, "primary")
  ] }]);
}

export function renderInstanceSteerCard(input: { instance: AgentInstance; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object {
  return card(`Steer · ${input.instance.name}`, "blue", [
    { tag: "markdown", content: "内容只注入当前活动 turn；若实例状态或 generation 已变化，提交会被拒绝。" },
    { tag: "form", name: "instance_steer_form", elements: [
      { tag: "input", name: "steer_text", input_type: "text", required: true, placeholder: { tag: "plain_text", content: "输入调整指令" } },
      formSubmitButton("发送 Steer", "instance_steer_submit", { action: "instance_steer_submit", instanceId: input.instance.id, generation: input.instance.generation, requestedBy: input.requestedBy, ...(input.bindingId ? { bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } : {}), ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}) }, "primary")
    ] }
  ]);
}

export function renderWorkerTaskInstructionCard(input: { workerName: string; turnId: string; intent: "steer" | "followup"; requestedBy: string; sourceCardMessageId: string; instanceId: string; generation: number; workerSessionGeneration: number }): object {
  const steer = input.intent === "steer";
  return card(steer ? `补充当前任务 · ${input.workerName}` : `继续这个任务 · ${input.workerName}`, "blue", [
    { tag: "markdown", content: steer ? "内容只会发送到这一个精确活动 turn；状态变化时会拒绝，不会自动排队。" : "内容会创建为一条新的 FIFO 后续任务，并保留当前任务作为父任务。" },
    { tag: "form", name: "worker_task_instruction_form", elements: [
      { tag: "input", name: "instruction_text", input_type: "text", required: true, placeholder: { tag: "plain_text", content: steer ? "输入补充要求" : "输入后续要求" } },
      formSubmitButton(steer ? "补充当前任务" : "创建后续任务", "worker_task_instruction_submit", { action: "worker_task_instruction_submit", intent: input.intent, turnId: input.turnId, instanceId: input.instanceId, generation: input.generation, workerSessionGeneration: input.workerSessionGeneration, sourceCardMessageId: input.sourceCardMessageId, requestedBy: input.requestedBy }, "primary")
    ] }
  ]);
}

export function renderWorkerNewTaskCard(input: { workerName: string; requestedBy: string; sourceCardMessageId: string; instanceId: string; generation: number; workerSessionGeneration: number }): object {
  return card(`发起新任务 · ${input.workerName}`, "blue", [
    { tag: "markdown", content: "这会创建一条独立 FIFO 任务，不会修改当前任务，也不会建立父任务关系。" },
    { tag: "form", name: "worker_new_task_form", elements: [
      { tag: "input", name: "task_text", input_type: "text", required: true, placeholder: { tag: "plain_text", content: "输入新任务" } },
      formSubmitButton("发起新任务", "worker_new_task_submit", { action: "worker_new_task_submit", instanceId: input.instanceId, generation: input.generation, workerSessionGeneration: input.workerSessionGeneration, sourceCardMessageId: input.sourceCardMessageId, requestedBy: input.requestedBy }, "primary")
    ] }
  ]);
}

export function renderInstanceRemovalPlanCard(input: { instance: AgentInstance; workspace: WorkspaceLease; plan: InstanceRemovalPlan; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object {
  const retained = !input.plan.safe;
  const evidence = [
    `**INSTANCE**  ${escape(input.instance.name)}   **GENERATION**  ${input.plan.instanceGeneration}`,
    `**WORKTREE**  ${input.workspace.kind} · ${escape(input.workspace.cwd)}`,
    `**WORKSPACE GENERATION**  ${input.plan.workspaceGeneration}   **STATE**  ${input.workspace.state}`,
    `**CHECK**  ${input.plan.reason}   **FINGERPRINT**  \`${input.plan.worktreeFingerprint ?? "—"}\``
  ].join("\n");
  const elements: object[] = [{ tag: "markdown", content: evidence }];
  if (retained) elements.push({ tag: "markdown", content: "⚠️ 检查结果不安全，实例和 worktree 已保留。请在本地处理后重新生成删除计划。" });
  else elements.push({ tag: "markdown", content: "删除会重新读取 SQLite 中的实例、workspace generation 与此计划；任一证据变化都会拒绝操作。" }, callbackButton("确认删除实例", { action: "instance_confirm_removal", instanceId: input.instance.id, generation: input.instance.generation, planId: input.plan.id, requestedBy: input.requestedBy, ...(input.bindingId ? { bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } : {}), ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}) }, "danger"));
  return card(retained ? `已保留 · ${input.instance.name}` : `确认删除 · ${input.instance.name}`, retained ? "orange" : "red", elements);
}

function card(title: string, template: string, elements: object[]): object {
  return { schema: "2.0", config: { update_multi: true, summary: { content: title } }, header: { title: { tag: "plain_text", content: title }, template }, body: { elements } };
}
function select(name: string, placeholder: string, values: Array<[string, string]>): object {
  return { tag: "select_static", name, required: true, placeholder: { tag: "plain_text", content: placeholder }, options: values.map(([content, value]) => ({ text: { tag: "plain_text", content }, value })) };
}
function escape(value: string): string { return value.replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&").slice(0, 300); }
