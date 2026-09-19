import type { BridgeConfig } from "../config.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { AnswerPageStore, MainCardStore } from "../domain/ports/projection.js";
import type { StartupViewStore } from "../domain/ports/workflow.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AnswerPageWorkflowPort } from "./answer-page-workflow.js";
import { AnswerPageWorkflow } from "./answer-page-workflow.js";
import { initialTopicView, mirrorRunCardToTopic, updateTopicView } from "../domain/topic-view.js";
import type { MainCardWorkflowPort } from "./main-card-workflow.js";
import { MainCardWorkflow } from "./main-card-workflow.js";
import type { Binding } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { Logger } from "pino";
import { safeLogError } from "../runtime/safe-error.js";
import { ProjectCatalog } from "./project-catalog.js";

export interface StartupViewConvergerPort { converge(): Promise<readonly string[]>; convergeBindings(bindingIds: readonly string[]): Promise<readonly string[]>; }
export interface StartupViewProjectionStores {
  startupViews: StartupViewStore;
  answerPages: AnswerPageStore;
  mainCards: MainCardStore;
}

export interface StartupViewConvergerOptions {
  config: Pick<BridgeConfig, "projects">;
  stores: StartupViewProjectionStores;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage">;
  answerPageWorkflow?: AnswerPageWorkflowPort;
  mainCardWorkflow?: MainCardWorkflowPort;
  logger?: Pick<Logger, "warn">;
}

export class StartupViewConverger implements StartupViewConvergerPort {
  private readonly projectRoutes: ProjectCatalog;
  private readonly pageWorkflow: AnswerPageWorkflowPort;
  private readonly mainCardWorkflow: MainCardWorkflowPort;
  private readonly store: StartupViewStore;
  private readonly outbound: OutboundIntentPort;
  private readonly outboundWork: OutboundWorkNotifier;
  private readonly presentation: StartupViewConvergerOptions["presentation"];
  private readonly logger: Pick<Logger, "warn"> | undefined;

  constructor(options: StartupViewConvergerOptions) {
    this.store = options.stores.startupViews;
    this.outbound = options.outbound;
    this.outboundWork = options.outboundWork;
    this.presentation = options.presentation;
    this.logger = options.logger;
    this.pageWorkflow = options.answerPageWorkflow ?? new AnswerPageWorkflow(options.stores.answerPages, () => options.outboundWork.wake(), options.presentation);
    this.mainCardWorkflow = options.mainCardWorkflow ?? new MainCardWorkflow(options.stores.mainCards, () => options.outboundWork.wake(), options.presentation);
    this.projectRoutes = new ProjectCatalog(options.config.projects);
  }

  async converge(): Promise<readonly string[]> {
    const retiredWorkerTaskCardIntents = this.store.retireUndeliveredWorkerTaskCardIntents();
    const recovered = this.store.recoverStaleOutboxQuarantines();
    const deliveryRecovered = recovered.retriedAnswerPromptIds.length > 0 || recovered.rolledBackAnswerPromptIds.length > 0 || recovered.dismissedNotices > 0
      || recovered.dismissedRejectedImmutableEffects > 0 || recovered.resolvedSupersededAnswerTargets > 0 || recovered.releasedSupersededWorkerMainUpdates > 0;
    const deliveryWorkReleased = recovered.retriedAnswerPromptIds.length > 0 || recovered.rolledBackAnswerPromptIds.length > 0
      || recovered.dismissedNotices > 0 || recovered.resolvedSupersededAnswerTargets > 0 || recovered.releasedSupersededWorkerMainUpdates > 0;
    if (retiredWorkerTaskCardIntents > 0 || deliveryRecovered || recovered.terminalizedQuarantines > 0) {
      if (deliveryWorkReleased) this.outboundWork.wake();
      this.logger?.warn({ event: "startup-outbox-quarantines-recovered", retiredWorkerTaskCardIntents, ...recovered, outcome: "converging" }, "recovered stale outbox quarantines and retired undelivered legacy Worker Task Card intents");
    }
    return this.convergeSelectedBindings(this.store.listStartupViewBindings());
  }

  async convergeBindings(bindingIds: readonly string[]): Promise<readonly string[]> {
    return this.convergeSelectedBindings(this.store.listStartupViewBindings(bindingIds));
  }

  private async convergeSelectedBindings(bindings: readonly Binding[]): Promise<readonly string[]> {
    const failed: string[] = [];
    for (const binding of bindings) {
      try {
        await this.convergeBinding(binding);
      } catch (error) {
        failed.push(binding.id);
        this.logger?.warn({ event: "startup-view-binding-failed", err: safeLogError(error), bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, outcome: "deferred" }, "failed to converge one binding's startup views");
      }
    }
    return failed;
  }

  private async convergeBinding(binding: Binding): Promise<void> {
      const spaceName = this.spaceNameFor(binding);
      const topicView = this.store.loadTopicView(binding.id);
      const currentTopicView = topicView ?? {
        ...initialTopicView(binding.id),
        title: binding.title,
        agentKind: binding.agentKind,
        workspaceId: binding.workspaceId,
        spaceName,
        paneId: binding.paneId
      };
      const reconciledTopicView = updateTopicView(currentTopicView, { title: binding.title, agentKind: binding.agentKind, workspaceId: binding.workspaceId, spaceName, paneId: binding.paneId });
      const runCards = this.store.listActionableStartupRunCards(binding.id);
      for (const view of runCards) {
        const identityChanged = view.spaceName !== spaceName || view.sessionTitle !== binding.title;
        const current = identityChanged ? this.store.saveRunCard({ ...view, spaceName, sessionTitle: binding.title, viewVersion: view.viewVersion + 1, updatedAt: new Date().toISOString() }) : view;
        if (!current.answerMessageId && binding.rootMessageId) { this.store.ensureAnswerCard(current.promptId, binding.rootMessageId, this.presentation.answerCard(current), "history"); this.outboundWork.wake(); }
        if (!current.answerCardId && current.answerMessageId && (identityChanged || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", this.presentation.answerCard(current), "history");
        else if (current.answerCardId) await this.pageWorkflow.converge(current.promptId, "history");
      }
      const latestRun = this.store.loadStartupMainRunCard(binding.id, reconciledTopicView.activePromptId);
      const terminal = binding.lifecycle === "draining" || binding.lifecycle === "archived" || binding.lifecycle === "closed" || binding.lifecycle === "failed";
      const finalTopic = !terminal && latestRun ? mirrorRunCardToTopic(reconciledTopicView, latestRun) : reconciledTopicView;
      await this.mainCardWorkflow.project(finalTopic, "history");
  }

  private spaceNameFor(binding: Binding): string { return this.projectRoutes.spaceNameForBinding(binding); }
}
