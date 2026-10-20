import type { BridgeConfig } from "../config.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { StartupViewStore } from "../domain/ports/workflow.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AnswerPageConvergencePort, MainCardConvergencePort, WorkerTurnCardConvergencePort } from "../domain/ports/card-convergence.js";
import { reduceRunCard } from "../domain/run-card-view.js";
import { initialTopicView, mirrorRunCardToTopic, updateTopicView } from "../domain/topic-view.js";
import type { Binding } from "../domain/types.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { Logger } from "pino";
import type { TurnCardWorkflow } from "./turn-card-workflow.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ProjectCatalog } from "./project-catalog.js";
import type { SessionActivityStore } from "../domain/ports/session-activity.js";

const MAX_RETAINED_ACTIVITY_RECOVERY_PAGES = 2;

export interface StartupViewConvergenceResult {
  readonly failedBindingIds: readonly string[];
  readonly fullRescanRequired: boolean;
}

export interface StartupViewConvergerPort { converge(): Promise<StartupViewConvergenceResult>; continueRetainedActivity(): Promise<StartupViewConvergenceResult>; convergeBindings(bindingIds: readonly string[]): Promise<readonly string[]>; }
export interface StartupViewProjectionStores {
  startupViews: StartupViewStore;
}

export interface StartupViewConvergerOptions {
  config: Pick<BridgeConfig, "projects">;
  stores: StartupViewProjectionStores;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage">;
  answerPages: AnswerPageConvergencePort;
  mainCards: MainCardConvergencePort;
  workerTurnCards?: WorkerTurnCardConvergencePort;
  turnCards?: Pick<TurnCardWorkflow, "convergeActionable">;
  sessionActivity?: Pick<SessionActivityStore, "recoverRetainedMultiAgentActivity">;
  logger?: Pick<Logger, "warn">;
  rolloutGuard?: { assertSemanticDeliveryStartupSafe(): void };
}

export class StartupViewConverger implements StartupViewConvergerPort {
  private retainedActivityRecoveryCursor: string | null = null;
  private readonly projectRoutes: ProjectCatalog;
  private readonly answerPages: AnswerPageConvergencePort;
  private readonly mainCards: MainCardConvergencePort;
  private readonly workerTurnCards: WorkerTurnCardConvergencePort | undefined;
  private readonly turnCards: Pick<TurnCardWorkflow, "convergeActionable"> | undefined;
  private readonly sessionActivity: Pick<SessionActivityStore, "recoverRetainedMultiAgentActivity"> | undefined;
  private readonly store: StartupViewStore;
  private readonly outbound: OutboundIntentPort;
  private readonly outboundWork: OutboundWorkNotifier;
  private readonly presentation: StartupViewConvergerOptions["presentation"];
  private readonly logger: Pick<Logger, "warn"> | undefined;
  private readonly rolloutGuard: StartupViewConvergerOptions["rolloutGuard"];

  constructor(options: StartupViewConvergerOptions) {
    this.store = options.stores.startupViews;
    this.outbound = options.outbound;
    this.outboundWork = options.outboundWork;
    this.presentation = options.presentation;
    this.logger = options.logger;
    this.rolloutGuard = options.rolloutGuard;
    this.answerPages = options.answerPages;
    this.mainCards = options.mainCards;
    this.workerTurnCards = options.workerTurnCards;
    this.turnCards = options.turnCards;
    this.sessionActivity = options.sessionActivity;
    this.projectRoutes = new ProjectCatalog(options.config.projects);
  }

  async converge(): Promise<StartupViewConvergenceResult> {
    const retainedActivityRecovery = this.recoverRetainedActivity();
    const completionReviewRecovery = this.store.recoverDeliveredCompletionReviews?.()
      ?? { activated: 0, alreadyActive: 0, alreadyTerminal: 0, invalid: 0 };
    if (completionReviewRecovery.invalid > 0) this.logger?.warn(
      { event: "startup-completion-review-receipts-invalid", ...completionReviewRecovery, outcome: "deferred" },
      "kept Completion Review presentations pending because their delivered receipt evidence was invalid"
    );
    const failedWorkerTurnIds = await this.workerTurnCards?.convergeActionable() ?? [];
    const failedTurnCardIds = await this.turnCards?.convergeActionable() ?? [];
    const retiredWorkerTaskCardIntents = this.store.retireUndeliveredWorkerTaskCardIntents();
    const recovered = this.store.recoverStaleOutboxQuarantines();
    const deliveryRecovered = recovered.retriedAnswerPromptIds.length > 0 || recovered.rolledBackAnswerPromptIds.length > 0 || recovered.dismissedNotices > 0
      || recovered.dismissedRejectedImmutableEffects > 0 || (recovered.dismissedDefunctTargets ?? 0) > 0 || recovered.resolvedSupersededAnswerTargets > 0 || recovered.releasedSupersededWorkerMainUpdates > 0
      || (recovered.retiredExpiredMessageDeletes ?? 0) > 0
      || (recovered.releasedSupersededPrimaryMainUpdates ?? 0) > 0 || (recovered.releasedSupersededPaneEntryUpdates ?? 0) > 0 || (recovered.releasedRejectedWorkerTurnFinalizers ?? 0) > 0 || (recovered.releasedAuthoritativeWorkerTurnSnapshots ?? 0) > 0;
    const deliveryWorkReleased = recovered.retriedAnswerPromptIds.length > 0 || recovered.rolledBackAnswerPromptIds.length > 0
      || recovered.dismissedNotices > 0 || (recovered.dismissedDefunctTargets ?? 0) > 0 || recovered.resolvedSupersededAnswerTargets > 0 || recovered.releasedSupersededWorkerMainUpdates > 0
      || (recovered.releasedSupersededPrimaryMainUpdates ?? 0) > 0 || (recovered.releasedSupersededPaneEntryUpdates ?? 0) > 0 || (recovered.releasedRejectedWorkerTurnFinalizers ?? 0) > 0 || (recovered.releasedAuthoritativeWorkerTurnSnapshots ?? 0) > 0;
    if (retiredWorkerTaskCardIntents > 0 || deliveryRecovered || recovered.terminalizedQuarantines > 0) {
      if (deliveryWorkReleased) this.outboundWork.wake();
      this.logger?.warn({ event: "startup-outbox-quarantines-recovered", retiredWorkerTaskCardIntents, ...recovered, outcome: "converging" }, "recovered stale outbox quarantines and retired undelivered legacy Worker Task Card intents");
    }
    const failedBindingIds = await this.convergeSelectedBindings(this.store.listStartupViewBindings());
    this.dismissEligibleLegacyCompletionNotifications();
    if (failedWorkerTurnIds.length > 0 || failedTurnCardIds.length > 0) {
      const details = [failedWorkerTurnIds.length > 0 ? `${failedWorkerTurnIds.length} Worker Task Card(s)` : "", failedTurnCardIds.length > 0 ? `${failedTurnCardIds.length} unified card(s)` : ""].filter(Boolean).join(", ");
      throw new Error(`Failed to converge ${details}`);
    }
    return { failedBindingIds, fullRescanRequired: retainedActivityRecovery.fullRescanRequired };
  }

  async continueRetainedActivity(): Promise<StartupViewConvergenceResult> {
    return this.recoverRetainedActivity();
  }

  private recoverRetainedActivity(): StartupViewConvergenceResult {
    this.rolloutGuard?.assertSemanticDeliveryStartupSafe();
    let retainedActivityRecovery = null as ReturnType<SessionActivityStore["recoverRetainedMultiAgentActivity"]> | null;
    for (let page = 0; page < MAX_RETAINED_ACTIVITY_RECOVERY_PAGES; page += 1) {
      retainedActivityRecovery = this.sessionActivity?.recoverRetainedMultiAgentActivity({
        limit: 128, observedAt: new Date().toISOString(), afterCursor: this.retainedActivityRecoveryCursor
      }) ?? null;
      this.retainedActivityRecoveryCursor = retainedActivityRecovery?.remaining ? retainedActivityRecovery.nextCursor : null;
      if (!retainedActivityRecovery?.remaining || !this.retainedActivityRecoveryCursor) break;
    }
    return { failedBindingIds: [], fullRescanRequired: retainedActivityRecovery?.remaining ?? false };
  }

  async convergeBindings(bindingIds: readonly string[]): Promise<readonly string[]> {
    const failedBindingIds = await this.convergeSelectedBindings(this.store.listStartupViewBindings(bindingIds));
    this.dismissEligibleLegacyCompletionNotifications(bindingIds);
    return failedBindingIds;
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

  private dismissEligibleLegacyCompletionNotifications(bindingIds?: readonly string[]): void {
    this.store.dismissEligibleLegacyCompletionNotifications(bindingIds);
  }

  private async convergeBinding(selected: Binding): Promise<void> {
      const binding = this.store.getBinding(selected.id);
      if (!binding || binding.generation !== selected.generation) return;
      if (binding.paneId === null && ["draining", "archived", "closed", "failed"].includes(binding.lifecycle)) return;
      const spaceName = this.spaceNameFor(binding);
      const topicView = this.store.loadTopicView(binding.id);
      const currentTopicView = topicView ?? {
        ...initialTopicView(binding.id),
        title: binding.title,
        agentKind: binding.agentKind,
        workspaceId: binding.workspaceId,
        spaceName,
        paneId: binding.paneId,
        paneToken: binding.paneToken
      };
      const reconciledTopicView = updateTopicView(currentTopicView, { title: binding.title, agentKind: binding.agentKind, workspaceId: binding.workspaceId, spaceName, paneId: binding.paneId, paneToken: binding.paneToken });
      const runCards = this.store.listActionableStartupRunCards(binding.id);
      for (const view of runCards) {
        try {
          const occurredAt = new Date().toISOString();
          const prompt = this.store.getPromptProjectionState(view.promptId);
          const terminalized = prompt?.state === "cancelled" && !["completed", "failed"].includes(view.phase)
            ? reduceRunCard(view, { type: "failed", occurredAt, notice: prompt.error ?? "Legacy input migrated to independent Agent Input." })
            : view;
          const refreshed = reduceRunCard(terminalized, { type: "display-context-refreshed", occurredAt, context: this.projectRoutes.runProjectionContextForBinding(binding) });
          const displayContextChanged = refreshed !== view;
          const current = displayContextChanged ? this.store.saveRunCard(refreshed) : view;
          if (!current.answerMessageId && binding.rootMessageId) { this.store.ensureAnswerCard(current.promptId, binding.rootMessageId, this.presentation.answerCard(current), "history"); this.outboundWork.wake(); }
          const answerPage = this.store.listAnswerPages(current.promptId).find(({ pageIndex }) => pageIndex === current.answerPageIndex);
          if (!current.answerCardId && current.answerMessageId && (displayContextChanged || current.viewVersion > current.answerDeliveredVersion)) await this.outbound.enqueueRunCardUpdate(current.bindingId, current.promptId, current.answerMessageId, current.viewVersion, "answer", this.presentation.answerCard(current), "history");
          else if (current.answerCardId) await this.answerPages.converge(current.promptId, "history");
        } catch (error) {
          this.logger?.warn({ event: "startup-answer-view-failed", err: safeLogError(error), bindingId: binding.id, promptId: view.promptId, outcome: "deferred" }, "failed to converge one Answer view; continuing with Main Card convergence");
        }
      }
      const latestRun = this.store.loadStartupMainRunCard(binding.id, reconciledTopicView.activePromptId);
      const terminal = binding.lifecycle === "draining" || binding.lifecycle === "archived" || binding.lifecycle === "closed" || binding.lifecycle === "failed";
      const finalTopic = !terminal && latestRun ? mirrorRunCardToTopic(reconciledTopicView, latestRun) : reconciledTopicView;
      await this.mainCards.project(finalTopic, "history");
  }

  private spaceNameFor(binding: Binding): string { return this.projectRoutes.spaceNameForBinding(binding); }
}
