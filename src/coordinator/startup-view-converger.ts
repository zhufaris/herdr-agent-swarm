import { renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { AnswerPageStore, MainCardStore, OutboundIntentPort, PromptAcceptanceStore } from "../domain/ports.js";
import type { AnswerPageWorkflowPort } from "./answer-page-workflow.js";
import { AnswerPageWorkflow } from "./answer-page-workflow.js";
import { initialTopicView, mirrorRunCardToTopic, updateTopicView } from "../domain/topic-view.js";
import type { MainCardWorkflowPort } from "./main-card-workflow.js";
import { MainCardWorkflow } from "./main-card-workflow.js";
import type { Binding } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";

export interface StartupViewConvergerPort { converge(): Promise<void>; }

export class StartupViewConverger implements StartupViewConvergerPort {
  private readonly projectsById = new Map<string, BridgeConfig["projects"][number]>();
  private readonly uniqueProjectsByWorkspace = new Map<string, BridgeConfig["projects"][number] | null>();
  private readonly pageWorkflow: AnswerPageWorkflowPort;
  private readonly mainCardWorkflow: MainCardWorkflowPort;

  constructor(
    private readonly config: Pick<BridgeConfig, "projects">,
    private readonly store: PromptAcceptanceStore,
    private readonly outbound: OutboundIntentPort,
    private readonly outboundWork: OutboundWorkNotifier,
    private readonly answerPages?: AnswerPageWorkflowPort,
    mainCards?: MainCardWorkflowPort
  ) {
    this.pageWorkflow = answerPages ?? new AnswerPageWorkflow(store as PromptAcceptanceStore & AnswerPageStore, () => outboundWork.wake());
    this.mainCardWorkflow = mainCards ?? new MainCardWorkflow(store as PromptAcceptanceStore & MainCardStore, () => outboundWork.wake());
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
      const reconciledTopicView = updateTopicView(currentTopicView, { title: binding.title, workspaceId: binding.workspaceId, spaceName, paneId: binding.paneId });
      const runCards = this.store.listRunCards(binding.id);
      for (const view of runCards) {
        if (!view.answerMessageId && binding.rootMessageId) { this.store.ensureAnswerCard(view.promptId, binding.rootMessageId, renderRequestAnswerCard(view)); this.outboundWork.wake(); }
        const current = view.spaceName !== spaceName ? this.store.saveRunCard({ ...view, spaceName, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerCardId && current.answerMessageId && (view.spaceName !== spaceName || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", renderRequestAnswerCard(current));
        else if (current.answerCardId) await this.pageWorkflow.converge(current.promptId);
      }
      const latestRun = runCards.at(-1);
      const finalTopic = latestRun ? mirrorRunCardToTopic(reconciledTopicView, latestRun) : reconciledTopicView;
      await this.mainCardWorkflow.project(finalTopic);
    }
  }

  private spaceNameFor(binding: Binding): string {
    const project = binding.projectId
      ? this.projectsById.get(binding.projectId)
      : this.uniqueProjectsByWorkspace.get(binding.workspaceId) ?? null;
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }
}
