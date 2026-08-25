import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { OutboundIntentPort, PromptAcceptanceStore } from "../domain/ports.js";
import { initialTopicView, mirrorRunCardToTopic } from "../domain/topic-view.js";
import type { Binding } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";

export interface StartupViewConvergerPort { converge(): Promise<void>; }

export class StartupViewConverger implements StartupViewConvergerPort {
  constructor(
    private readonly config: Pick<BridgeConfig, "projects">,
    private readonly store: PromptAcceptanceStore,
    private readonly outbound: OutboundIntentPort,
    private readonly outboundWork: OutboundWorkNotifier
  ) {}

  async converge(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      const spaceName = this.spaceNameFor(binding);
      const topicView = this.store.loadTopicView(binding.id);
      const currentTopicView = topicView ?? {
        ...initialTopicView(binding.id),
        title: binding.title,
        workspaceId: binding.workspaceId,
        spaceName,
        paneId: binding.paneId
      };
      const topicViewChanged = !topicView
        || currentTopicView.title !== binding.title
        || currentTopicView.workspaceId !== binding.workspaceId
        || currentTopicView.spaceName !== spaceName
        || currentTopicView.paneId !== binding.paneId;
      const reconciledTopicView = topicViewChanged
        ? { ...currentTopicView, title: binding.title, workspaceId: binding.workspaceId, spaceName, paneId: binding.paneId }
        : currentTopicView;
      if (topicViewChanged) {
        const current = reconciledTopicView;
        this.store.saveTopicView(current);
      }
      // A root card can predate the durable view (or have been left stale by an
      // interrupted projection). Re-send the converged snapshot once per binding
      // version through the outbox, rather than making a direct Lark update.
      if (binding.statusMessageId) await this.outbound.enqueueCardUpdate(
        binding.id,
        binding.statusMessageId,
        `startup-root-card-reconcile:${binding.id}:${binding.updatedAt}`,
        renderProjectEntryCard(reconciledTopicView)
      );
      const runCards = this.store.listRunCards(binding.id);
      for (const view of runCards.filter((item) => item.larkMessageId)) {
        if (!view.answerMessageId && binding.rootMessageId) { this.store.ensureAnswerCard(view.promptId, binding.rootMessageId, renderRequestAnswerCard(view)); this.outboundWork.wake(); }
        const current = view.spaceName !== spaceName ? this.store.saveRunCard({ ...view, spaceName, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerCardId && current.answerMessageId && (view.spaceName !== spaceName || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", renderRequestAnswerCard(current));
      }
      const latestRun = runCards.at(-1);
      const currentTopic = this.store.loadTopicView(binding.id) ?? reconciledTopicView;
      if (latestRun && currentTopic && binding.statusMessageId) {
        const mirrored = mirrorRunCardToTopic(currentTopic, latestRun);
        this.store.saveTopicView(mirrored);
        await this.outbound.enqueueCardUpdate(binding.id, binding.statusMessageId, `startup-primary-sync:${binding.id}:${latestRun.promptId}:${latestRun.viewVersion}`, renderProjectEntryCard(mirrored));
      }
    }
  }

  private spaceNameFor(binding: Binding): string {
    const matches = binding.projectId
      ? this.config.projects.filter((project) => project.id === binding.projectId)
      : this.config.projects.filter((project) => project.workspaceId === binding.workspaceId);
    return matches.length === 1 ? projectSpaceName(matches[0]!) : "legacy/unresolved";
  }
}
