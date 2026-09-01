import type { AgentInstance, WorkspaceLease } from "../domain/agent-instance.js";
import type { AgentCapabilities } from "../domain/agent-runtime.js";
import type { InstanceTurn } from "../domain/instance-turn.js";
import { safeLogError } from "../runtime/safe-error.js";
import { callbackButton } from "./cardkit-button.js";

export function renderInstanceDetailCard(input: { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; turns: InstanceTurn[]; queueDepth: number; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object {
  const active = input.turns.find(({ state }) => ["claimed", "dispatching", "running", "blocked", "dispatch-uncertain"].includes(state));
  const recent = [...input.turns].reverse().find(({ result }) => result)?.result ?? "—";
  const runtime = input.instance.runtimeRef;
  const elements: object[] = [{ tag: "markdown", content: [
    `**ROLE**  ${input.instance.role}   **AGENT**  ${input.instance.agentKind}   **STATE**  ${input.instance.observedState}`,
    `**MODEL**  ${input.instance.model ?? "—"}   **GENERATION**  ${input.instance.generation}   **QUEUE**  ${input.queueDepth}`,
    `**HERDR**  ${runtime ? `${runtime.herdrWorkspaceId} / ${runtime.paneId}` : "—"}`,
    `**WORKTREE**  ${input.workspace.kind} · ${input.workspace.cwd}`,
    `**BRANCH**  ${input.workspace.branch ?? "—"}   **BASE**  ${input.workspace.baseCommit}   **GIT**  ${input.workspace.state}`,
    `**PROVISIONING**  ${input.instance.provisioningCheckpoint}`,
    ...(input.instance.lastError ? [`**LAST ERROR**  ${safeLogError(new Error(input.instance.lastError)).message}`] : []),
    `**ACTIVE TURN**  ${active?.id ?? "—"}`, `**RECENT RESULT**  ${recent.slice(0, 240)}`
  ].join("\n") }];
  const context = { ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}), ...(input.bindingId ? { bindingId: input.bindingId, bindingGeneration: input.bindingGeneration } : {}) };
  const controls = [callbackButton("设为当前目标", { action: "instance_set_target", instanceId: input.instance.id, generation: input.instance.generation, ...context }, "primary")];
  if (input.instance.desiredState === "stopped") controls.push(callbackButton("启动", { action: "instance_start", instanceId: input.instance.id, generation: input.instance.generation, ...context }));
  else controls.push(callbackButton("停止", { action: "instance_stop", instanceId: input.instance.id, generation: input.instance.generation, ...context }));
  if (input.capabilities.steering !== "unsupported" && ["working", "blocked"].includes(input.instance.observedState)) controls.push(callbackButton("Steer", { action: "instance_steer_form", instanceId: input.instance.id, generation: input.instance.generation, ...context }));
  if (["working", "blocked"].includes(input.instance.observedState)) controls.push(callbackButton("Interrupt", { action: "instance_interrupt", instanceId: input.instance.id, generation: input.instance.generation, ...context }, "danger"));
  if (input.instance.desiredState === "stopped" && !input.instance.runtimeRef) controls.push(callbackButton("删除…", { action: "instance_plan_removal", instanceId: input.instance.id, generation: input.instance.generation, ...context }, "danger"));
  elements.push({
    tag: "column_set", flex_mode: "none", horizontal_spacing: "8px",
    columns: controls.map((control) => ({ tag: "column", width: "auto", elements: [control] }))
  });
  return { schema: "2.0", config: { update_multi: true, summary: { content: input.instance.name } }, header: { title: { tag: "plain_text", content: `${input.instance.name} · ${input.instance.agentKind}` }, template: input.instance.observedState === "failed" ? "red" : "turquoise" }, body: { elements } };
}
