import { projectSpaceName } from "../../config.js";
import { createBridgeEvent } from "../../domain/create-bridge-event.js";
import type { BindingProvisioningStore } from "../../domain/ports/binding.js";
import type { HerdrPort, LarkPort } from "../../domain/ports/external.js";
import type { PrimaryPresentation } from "../../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../../domain/topic-view.js";
import type { Binding, ProjectConfig, ProjectSelection } from "../../domain/types.js";
import type { LifecycleEventPublisher } from "../../events/bridge-event-bus.js";
import type { Logger } from "pino";
import { safeLogError } from "../../runtime/safe-error.js";
import { requireMatchingPane } from "../pane-runtime-identity.js";
import { PRIMARY_TOOLS_UNAVAILABLE_NOTICE } from "./managed-binding-lifecycle.js";

export class BindingStartupRecovery {
  constructor(private readonly options: {
    store: BindingProvisioningStore; herdr: HerdrPort; lark: LarkPort; logger: Logger; projectsById: ReadonlyMap<string, ProjectConfig>; lifecycleEvents: LifecycleEventPublisher; presentation: Pick<PrimaryPresentation, "mainCard">;
    recoverSelection(selection: ProjectSelection): Promise<void>;
    publish(bindingId: string, type: "BindingActivated" | "PrimaryToolAvailabilityChanged", origin: "bridge", payload: Record<string, unknown>): Promise<void>;
  }) {}

  async recover(): Promise<void> {
    const selections = this.options.store.listProcessingProjectSelections();
    for (const selection of selections) await this.options.recoverSelection(selection);
    const selectionBindingIds = new Set(selections.flatMap((selection) => selection.bindingId ? [selection.bindingId] : []));
    for (const binding of this.options.store.listBindingsByState("pending").filter((candidate) => candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "runtime_started" && !selectionBindingIds.has(candidate.id))) await this.recoverDiscoveredBinding(binding);
    for (const binding of this.options.store.listBindingsByState("active")) {
      const view = this.options.store.loadTopicView(binding.id);
      if (!this.options.store.hasBindingPrimaryToolCapability(binding.id, binding.generation) && (view?.primaryToolsAvailable !== false || view.primaryToolsNotice !== PRIMARY_TOOLS_UNAVAILABLE_NOTICE)) await this.options.publish(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    }
  }

  private async recoverDiscoveredBinding(binding: Binding): Promise<void> {
    if (!binding.paneId || !binding.projectId) return; const project = this.options.projectsById.get(binding.projectId); if (!project) return;
    try {
      this.options.store.revokeBindingPrimaryToolCapability(binding.id, binding.generation); const pane = await requireMatchingPane(this.options.herdr, this.options.projectsById, binding, binding.paneId);
      const createdEvent = createBridgeEvent(binding.id, "BindingCreated", "herdr", { title: binding.title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), tabId: pane.tabId ?? null, paneId: pane.paneId }); const unavailableEvent = createBridgeEvent(binding.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
      const view = reduceTopicView(reduceTopicView(this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id), createdEvent), unavailableEvent); const topic = await this.options.lark.createTopic(this.options.presentation.mainCard(view), binding.id); this.options.store.recordBridgeMessage(topic.rootMessageId); this.options.store.saveTopicView({ ...view, deliveredVersion: view.viewVersion });
      let next = this.options.store.updateBindingMetadata(binding.id, { topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId }); next = this.options.store.transitionBinding(next.id, { type: "thread_created" }); next = this.options.store.transitionBinding(next.id, { type: "activate" });
      await this.options.lifecycleEvents.publish(createdEvent); await this.options.lifecycleEvents.publish(unavailableEvent); await this.options.publish(next.id, "BindingActivated", "bridge", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: topic.topicId }); this.options.logger.info({ event: "discovered-binding-recovered", bindingId: next.id, paneId: pane.paneId, outcome: "completed" }, "resumed interrupted discovered-pane provisioning");
    } catch (error) { this.options.logger.error({ event: "discovered-binding-recovery-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, outcome: "retry_on_restart" }, "discovered-pane provisioning remains recoverable"); }
  }
}
