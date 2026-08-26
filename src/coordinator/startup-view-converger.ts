import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { OutboundIntentPort, PromptAcceptanceStore } from "../domain/ports.js";
import { initialTopicView, mirrorRunCardToTopic } from "../domain/topic-view.js";
import type { Binding } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../runtime/answer-stream.js";

export interface StartupViewConvergerPort { converge(): Promise<void>; }

export class StartupViewConverger implements StartupViewConvergerPort {
  private readonly projectsById = new Map<string, BridgeConfig["projects"][number]>();
  private readonly uniqueProjectsByWorkspace = new Map<string, BridgeConfig["projects"][number] | null>();

  constructor(
    private readonly config: Pick<BridgeConfig, "projects">,
    private readonly store: PromptAcceptanceStore,
    private readonly outbound: OutboundIntentPort,
    private readonly outboundWork: OutboundWorkNotifier
  ) {
    for (const project of config.projects) {
      this.projectsById.set(project.id, project);
      const existing = this.uniqueProjectsByWorkspace.get(project.workspaceId);
      this.uniqueProjectsByWorkspace.set(project.workspaceId, existing === undefined ? project : null);
    }
  }

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
      for (const view of runCards) {
        if (!view.answerMessageId && binding.rootMessageId) { this.store.ensureAnswerCard(view.promptId, binding.rootMessageId, renderRequestAnswerCard(view)); this.outboundWork.wake(); }
        const current = view.spaceName !== spaceName ? this.store.saveRunCard({ ...view, spaceName, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerCardId && current.answerMessageId && (view.spaceName !== spaceName || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", renderRequestAnswerCard(current));
        else if (current.answerCardId && current.viewVersion > current.answerDeliveredVersion && !this.store.hasPendingAnswerContinuation(current.promptId, current.answerPageIndex + 1)) {
          const content = answerStreamContent(current);
          const { page, nextPageStart } = renderAnswerStreamPage(content, current.answerPageStart, ANSWER_STREAM_PAGE_LIMIT);
          // Recover the same per-stream-element sequence protocol used by live
          // projection. A continuation page starts from sequence 1.
          const sequence = current.answerSequence + 1;
          this.store.saveRunCard({ ...current, answerSequence: sequence });
          await this.outbound.enqueueStreamContent(current.bindingId, current.promptId, current.answerCardId, current.answerElementId, page, sequence);
          if (nextPageStart === null && (current.phase === "completed" || current.phase === "failed")) await this.outbound.enqueueStreamFinish(current.bindingId, current.promptId, current.answerCardId, current.phase === "completed" ? "Completed" : "Failed", sequence + 1);
        }
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
    const project = binding.projectId
      ? this.projectsById.get(binding.projectId)
      : this.uniqueProjectsByWorkspace.get(binding.workspaceId) ?? null;
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }
}
