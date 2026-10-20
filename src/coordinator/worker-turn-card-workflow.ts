import type { Logger } from "pino";
import { continuationSummary } from "../domain/card-page-handoff.js";
import type { WorkerTurnCardConvergencePort } from "../domain/ports/card-convergence.js";
import type { WorkerTurnCardStore } from "../domain/ports/instance.js";
import type { ApplicationPresentation, WorkerPresentation } from "../domain/ports/presentation.js";
import { workerTurnElementId, workerTurnProgressElementId } from "../domain/worker-turn-card-view.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import { lateAnswerTimelineResults } from "../domain/answer-timeline-late-results.js";
import { projectionGapWarning } from "../domain/projection-gap.js";
import { safeLogError } from "../runtime/safe-error.js";

type WorkerTurnCardPresentation = Pick<WorkerPresentation, "workerTurn" | "workerTurnPage" | "workerTurnProgress" | "answerTimelinePage"> &
  Partial<Pick<ApplicationPresentation, "completionReview">>;

export class WorkerTurnCardWorkflow implements WorkerTurnCardConvergencePort {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: WorkerTurnCardStore,
    private readonly wakeOutbound: () => void,
    private readonly presentation: WorkerTurnCardPresentation,
    private readonly pageLimit = 9_000,
    private readonly logger?: Pick<Logger, "debug" | "warn">
  ) {}

  async convergeActionable(): Promise<readonly string[]> {
    const failed: string[] = [];
    for (const turnId of this.store.listActionableWorkerTurnCardIds()) {
      try {
        await this.converge(turnId);
      } catch (error) {
        failed.push(turnId);
        this.logger?.warn({ event: "startup-worker-turn-card-failed", turnId, err: safeLogError(error), outcome: "deferred" }, "failed to converge one Worker Task Card during startup");
      }
    }
    return failed;
  }

  converge(turnId: string): Promise<void> {
    const previous = this.tails.get(turnId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.convergeOnce(turnId));
    const tail = work.catch(() => undefined);
    this.tails.set(turnId, tail);
    void tail.then(() => { if (this.tails.get(turnId) === tail) this.tails.delete(turnId); });
    return work;
  }

  private async convergeOnce(turnId: string): Promise<void> {
    const view = this.store.loadWorkerTurnCard(turnId);
    const pages = this.store.listWorkerTurnCardPages(turnId);
    const page = pages.find(({ state }) => state === "active") ?? (view?.phase === "completed" ? pages.findLast(({ state }) => state === "finished") : undefined);
    if (!view) return;
    if (!page) {
      const frozen = pages.findLast(({ state }) => state === "frozen");
      if (frozen) this.reserveRecovery(view, frozen);
      return;
    }
    if (!page.messageId) return;
    const gapWarning = projectionGapWarning(this.store.getWorkerProjectionGapSummary(turnId));
    if (!page.cardId) {
      const options = view.timelineItems.length > 0
        ? { timelineItems: this.presentation.answerTimelinePage(view.timelineItems, { itemIndex: 0, markdownOffset: 0 }, this.pageLimit).items, gapWarning, completionActions: null }
        : { initialContent: this.presentation.workerTurnPage(view, page.pageStart, this.pageLimit).page, gapWarning, completionActions: null };
      const outcome = this.store.reserveWorkerTurnCardHydration({ turnId, pageIndex: page.pageIndex, cardId: null, messageId: page.messageId, card: this.presentation.workerTurn(view, page, options) });
      if (outcome === "reserved") this.wakeOutbound();
      this.log(turnId, page.pageIndex, "recover-static", outcome);
      return;
    }
    if (view.timelineItems.length > 0) {
      this.convergeTimeline(view, page, gapWarning);
      return;
    }

    let reserved = false;
    const reserve = (outcome: "reserved" | "waiting" | "stale") => { reserved ||= outcome === "reserved"; return outcome; };
    if (["queued", "preparing", "running", "blocked"].includes(view.phase)) {
      const progress = this.presentation.workerTurnProgress(view);
      reserve(this.store.reserveWorkerTurnProgress({
        turnId, pageIndex: page.pageIndex, cardId: page.cardId,
        elementId: workerTurnProgressElementId(turnId, page.pageIndex),
        content: gapWarning ? `${progress}\n\n${gapWarning}` : progress
      }));
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "progress", reserved ? "reserved" : "waiting");
      return;
    }

    if (page.state === "finished") {
      if (this.reserveFreshCompletionReview(view, page)) {
        this.wakeOutbound();
        this.log(turnId, page.pageIndex, "completion-review", "reserved");
        return;
      }
      reserve(this.store.reserveWorkerTurnCardHydration({
        turnId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId,
        card: this.presentation.workerTurn(view, page, { gapWarning, completionActions: null })
      }));
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "hydrate", reserved ? "reserved" : "waiting");
      return;
    }

    if (view.phase !== "completed") {
      reserve(this.store.reserveWorkerTurnCardHydration({
        turnId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId,
        card: this.presentation.workerTurn(view, page, { gapWarning })
      }));
      reserve(this.store.reserveWorkerTurnFinish({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: terminalSummary(view.phase) }));
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "finish", reserved ? "reserved" : "waiting");
      return;
    }

    const facts = this.store.getWorkerTurnCardDeliveryFacts(turnId, page.pageIndex);
    if (facts.continuationPending || facts.latestContent?.state === "pending" || facts.latestContent?.state === "dead_letter") {
      if (reserved) this.wakeOutbound();
      return;
    }
    const rendered = this.presentation.workerTurnPage(view, page.pageStart, this.pageLimit);
    if (typeof facts.latestContent?.sourceEnd === "number" && facts.latestContent.sourceEnd > page.pageStart) {
      if (facts.latestContent.sourceEnd < rendered.sourceLength) reserve(this.reserveContinuation(view, page, facts.latestContent.sourceEnd));
      else if (!facts.finishPending) reserve(this.reserveFinalSnapshotOrFinish(view, page, gapWarning));
    } else if (rendered.page && facts.latestContent?.content !== rendered.page) {
      reserve(this.store.reserveWorkerTurnContent({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, elementId: page.elementId, content: rendered.page, sourceEnd: rendered.nextPageStart ?? rendered.sourceLength }));
    } else if (rendered.nextPageStart !== null && !facts.finishPending) {
      reserve(this.reserveContinuation(view, page, rendered.nextPageStart));
    } else if (!facts.finishPending) {
      reserve(this.reserveFinalSnapshotOrFinish(view, page, gapWarning));
    }
    if (reserved) this.wakeOutbound();
    this.log(turnId, page.pageIndex, "content", reserved ? "reserved" : "waiting");
  }

  private convergeTimeline(view: NonNullable<ReturnType<WorkerTurnCardStore["loadWorkerTurnCard"]>>, page: ReturnType<WorkerTurnCardStore["listWorkerTurnCardPages"]>[number], gapWarning: string | null): void {
    const checkpoint = this.store.getWorkerAnswerTimelinePage(view.turnId, page.pageIndex);
    const lateResults = lateAnswerTimelineResults(view.timelineItems, this.store.listFrozenWorkerAnswerTimelineItems(view.turnId, page.pageIndex));
    const plan = this.presentation.answerTimelinePage(view.timelineItems, checkpoint.startCursor, this.pageLimit, lateResults);
    const card = this.presentation.workerTurn(view, page, { timelineItems: plan.items, gapWarning, completionActions: null });
    const outcome = this.store.reserveWorkerAnswerTimelineCard({ turnId: view.turnId, pageIndex: page.pageIndex, messageId: page.messageId!, card, cursor: plan.nextCursor, items: plan.items });
    if (outcome === "reserved") { this.wakeOutbound(); return; }
    const delivered = this.store.getWorkerAnswerTimelinePage(view.turnId, page.pageIndex);
    if (delivered.pending || !sameCursor(delivered.deliveredCursor, plan.nextCursor)) return;
    if (plan.nextCursor) {
      const nextPageIndex = page.pageIndex + 1;
      const nextElementId = workerTurnElementId(view.turnId, nextPageIndex);
      const next = this.presentation.answerTimelinePage(view.timelineItems, plan.nextCursor, this.pageLimit);
      const continuation = this.store.reserveWorkerTurnContinuation({
        turnId: view.turnId, pageIndex: page.pageIndex, cardId: page.cardId!, summary: continuationSummary(nextPageIndex), nextPageIndex, nextPageStart: nextPageIndex, nextElementId,
        rootMessageId: view.rootMessageId, viewVersion: view.viewVersion, timelineStartCursor: plan.nextCursor, timelineEndCursor: next.nextCursor, timelineItems: next.items,
        card: this.presentation.workerTurn(view, { id: `${view.turnId}:${nextPageIndex}`, turnId: view.turnId, pageIndex: nextPageIndex, pageStart: nextPageIndex, elementId: nextElementId, messageId: null, cardId: null, state: "creating", sequence: 0, createdAt: view.updatedAt, updatedAt: view.updatedAt }, { timelineItems: next.items, gapWarning: projectionGapWarning(this.store.getWorkerProjectionGapSummary(view.turnId)) })
      });
      if (continuation === "reserved") this.wakeOutbound();
      return;
    }
    if (view.phase === "completed") {
      const outcome = this.reserveFinalSnapshotOrFinish(view, page, gapWarning, plan.items);
      if (outcome === "reserved") this.wakeOutbound();
    }
  }

  private reserveContinuation(view: NonNullable<ReturnType<WorkerTurnCardStore["loadWorkerTurnCard"]>>, page: ReturnType<WorkerTurnCardStore["listWorkerTurnCardPages"]>[number], nextPageStart: number) {
    const nextPageIndex = page.pageIndex + 1;
    const nextElementId = workerTurnElementId(view.turnId, nextPageIndex);
    return this.store.reserveWorkerTurnContinuation({
      turnId: view.turnId, pageIndex: page.pageIndex, cardId: page.cardId!, summary: continuationSummary(nextPageIndex),
      nextPageIndex, nextPageStart, nextElementId, rootMessageId: view.rootMessageId, viewVersion: view.viewVersion,
      card: this.presentation.workerTurn(view, {
        id: `${view.turnId}:${nextPageIndex}`, turnId: view.turnId, pageIndex: nextPageIndex, pageStart: nextPageStart,
        elementId: nextElementId, messageId: null, cardId: null, state: "creating", sequence: 0, createdAt: view.updatedAt, updatedAt: view.updatedAt
      }, { initialContent: this.presentation.workerTurnPage(view, nextPageStart, this.pageLimit).page, gapWarning: projectionGapWarning(this.store.getWorkerProjectionGapSummary(view.turnId)) })
    });
  }

  private reserveRecovery(view: NonNullable<ReturnType<WorkerTurnCardStore["loadWorkerTurnCard"]>>, previous: ReturnType<WorkerTurnCardStore["listWorkerTurnCardPages"]>[number]): void {
    const nextPageIndex = previous.pageIndex + 1;
    const nextElementId = workerTurnElementId(view.turnId, nextPageIndex);
    const nextPage = {
      ...previous,
      id: `${view.turnId}:${nextPageIndex}`,
      pageIndex: nextPageIndex,
      elementId: nextElementId,
      messageId: null,
      cardId: null,
      state: "creating" as const,
      sequence: 0
    };
    const gapWarning = projectionGapWarning(this.store.getWorkerProjectionGapSummary(view.turnId));
    const options = view.timelineItems.length > 0
      ? { timelineItems: this.presentation.answerTimelinePage(view.timelineItems, { itemIndex: 0, markdownOffset: 0 }, this.pageLimit).items, gapWarning, completionActions: null }
      : { initialContent: this.presentation.workerTurnPage(view, previous.pageStart, this.pageLimit).page, gapWarning, completionActions: null };
    const outcome = this.store.reserveWorkerTurnRecovery({
      turnId: view.turnId,
      previousPageIndex: previous.pageIndex,
      nextPageIndex,
      pageStart: previous.pageStart,
      nextElementId,
      rootMessageId: view.rootMessageId,
      viewVersion: view.viewVersion,
      card: this.presentation.workerTurn(view, nextPage, options)
    });
    if (outcome === "reserved") this.wakeOutbound();
    this.log(view.turnId, previous.pageIndex, "recover", outcome);
  }

  private log(turnId: string, pageIndex: number, action: string, outcome: string): void {
    this.logger?.debug({ event: "worker-turn-card-converged", turnId, pageIndex, action, outcome }, "planned durable Worker Task Card delivery");
  }

  private reserveFreshCompletionReview(
    view: NonNullable<ReturnType<WorkerTurnCardStore["loadWorkerTurnCard"]>>,
    page: ReturnType<WorkerTurnCardStore["listWorkerTurnCardPages"]>[number]
  ): boolean {
    if (!this.presentation.completionReview || !page.cardId || !page.messageId) return false;
    const review = this.store.prepareWorkerCompletionActionSet({
      turnId: view.turnId,
      pageIndex: page.pageIndex,
      cardId: page.cardId,
      messageId: page.messageId,
      card: ({ actionSetId, mentionOpenId, choiceSpecification }) => this.presentation.completionReview!({
        actionSetId,
        mentionOpenId,
        subjectLabel: `Worker · ${view.workerName}`,
        choiceSpecification
      })
    });
    return review?.state === "available" && review.presentationKind === "fresh-card";
  }

  private reserveFinalSnapshotOrFinish(
    view: NonNullable<ReturnType<WorkerTurnCardStore["loadWorkerTurnCard"]>>,
    page: ReturnType<WorkerTurnCardStore["listWorkerTurnCardPages"]>[number],
    gapWarning: string | null,
    timelineItems?: readonly import("../domain/answer-timeline.js").AnswerTimelineItem[]
  ): "reserved" | "waiting" | "stale" {
    if (!page.cardId || !page.messageId) return "stale";
    const completionActions = null;
    const finalUpdateState = this.store.getWorkerTurnCardDeliveryFacts(view.turnId, page.pageIndex).finalUpdateState;
    if (finalUpdateState === null || finalUpdateState === "dead_letter" || finalUpdateState === "dismissed") {
      return this.store.reserveWorkerTurnCardHydration({
        turnId: view.turnId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId,
        card: this.presentation.workerTurn(view, page, { ...(timelineItems ? { timelineItems } : {}), gapWarning, completionActions })
      });
    }
    if (finalUpdateState === "pending") return "waiting";
    return this.store.reserveWorkerTurnFinish({ turnId: view.turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: "Completed" });
  }
}
function sameCursor(left: AnswerTimelineCursor | null, right: AnswerTimelineCursor | null): boolean {
  return left?.itemIndex === right?.itemIndex && left?.markdownOffset === right?.markdownOffset && left?.section === right?.section && left?.offset === right?.offset || left === null && right === null;
}

function terminalSummary(phase: string): string {
  if (phase === "failed") return "Failed";
  if (phase === "cancelled") return "Cancelled";
  return "Dispatch uncertain";
}
