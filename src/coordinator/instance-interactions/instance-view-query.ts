import type { AgentInstance } from "../../domain/agent-instance.js";
import type { InstanceStore } from "../../domain/ports/instance.js";
import type { ApplicationPresentation } from "../../domain/ports/presentation.js";
import type { ProjectConfig } from "../../domain/types.js";
import type { AgentDriverRegistry } from "../../runtime/agents/agent-driver.js";
import type { InstanceControlWorkflow } from "../instance-control-workflow.js";

export class InstanceViewQuery {
  constructor(private readonly options: { store: InstanceStore; control: InstanceControlWorkflow; drivers: AgentDriverRegistry; presentation: Pick<ApplicationPresentation, "instanceDetail" | "instanceDirectory"> }) {}

  directory(project: ProjectConfig, conversationKey: string): object {
    const selected = this.options.store.getConversationTarget(conversationKey);
    const target = selected?.projectId === project.id ? selected.target : { kind: "primary" as const };
    const binding = conversationKey.startsWith("binding:") ? this.options.store.getBinding(conversationKey.slice("binding:".length)) : null;
    const entries = binding?.paneId ? this.options.control.listWorkersForParent({ bindingId: binding.id, paneId: binding.paneId }).map((instance) => ({ instance, workspace: this.options.control.inspect(instance.id).workspace, capabilities: this.options.drivers.describe(instance.agentKind), queueDepth: this.options.store.countPendingInstanceTurns(instance.id) })) : [];
    const primary = binding ? { bindingId: binding.id, generation: binding.generation, paneId: binding.paneId, state: binding.state } : null;
    return this.options.presentation.instanceDirectory({ project, entries, target, primary, conversationKey });
  }

  detail(instance: AgentInstance, conversationKey: string): object {
    const view = this.options.control.inspect(instance.id);
    const binding = conversationKey.startsWith("binding:") ? this.options.store.getBinding(conversationKey.slice("binding:".length)) : null;
    return this.options.presentation.instanceDetail({ ...view, capabilities: this.options.drivers.describe(instance.agentKind), turns: this.options.store.listRecentInstanceTurnSummaries(instance.id), activeTurnId: this.options.store.getActiveInstanceTurn(instance.id, instance.generation)?.id ?? null, queueDepth: this.options.store.countPendingInstanceTurns(instance.id), conversationKey, ...(binding ? { bindingId: binding.id, bindingGeneration: binding.generation } : {}) });
  }
}
