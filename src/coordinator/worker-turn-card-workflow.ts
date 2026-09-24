import type { Logger } from "pino";
import { continuationSummary } from "../domain/card-page-handoff.js";
import type { WorkerTurnCardConvergencePort } from "../domain/ports/card-convergence.js";
import type { WorkerTurnCardStore } from "../domain/ports/instance.js";
import type { WorkerPresentation } from "../domain/ports/presentation.js";
import { workerTurnElementId, workerTurnProgressElementId } from "../domain/worker-turn-card-view.js";

type WorkerTurnCardPresentation = Pick<WorkerPresentation, "workerTurn" | "workerTurnPage" | "workerTurnProgress">;

export class WorkerTurnCardWorkflow implements WorkerTurnCardConvergencePort {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: WorkerTurnCardStore,
    private readonly wakeOutbound: () => void,
    private readonly presentation: WorkerTurnCardPresentation,
    private readonly pageLimit = 9_000,
    private readonly logger?: Pick<Logger, "debug">
  ) {}

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
    if (!view || !page?.cardId || !page.messageId) return;

    let reserved = false;
    const reserve = (outcome: "reserved" | "waiting" | "stale") => { reserved ||= outcome === "reserved"; return outcome; };
    if (["queued", "preparing", "running", "blocked"].includes(view.phase)) {
      reserve(this.store.reserveWorkerTurnProgress({
        turnId, pageIndex: page.pageIndex, cardId: page.cardId,
        elementId: workerTurnProgressElementId(turnId, page.pageIndex),
        content: this.presentation.workerTurnProgress(view)
      }));
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "progress", reserved ? "reserved" : "waiting");
      return;
    }

    reserve(this.store.reserveWorkerTurnCardHydration({
      turnId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId,
      card: this.presentation.workerTurn(view, page)
    }));
    if (page.state === "finished") {
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "hydrate", reserved ? "reserved" : "waiting");
      return;
    }

    if (view.phase !== "completed") {
      reserve(this.store.reserveWorkerTurnFinish({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: terminalSummary(view.phase) }));
      if (reserved) this.wakeOutbound();
      this.log(turnId, page.pageIndex, "finish", reserved ? "reserved" : "waiting");
      return;
    }

    const facts = this.store.getWorkerTurnCardDeliveryFacts(turnId, page.pageIndex);
    const rendered = this.presentation.workerTurnPage(view, page.pageStart, this.pageLimit);
    if (facts.continuationPending || facts.latestContent?.state === "pending" || facts.latestContent?.state === "dead_letter") {
      if (reserved) this.wakeOutbound();
      return;
    }
    if (typeof facts.latestContent?.sourceEnd === "number" && facts.latestContent.sourceEnd > page.pageStart) {
      if (facts.latestContent.sourceEnd < rendered.sourceLength) reserve(this.reserveContinuation(view, page, facts.latestContent.sourceEnd));
      else if (!facts.finishPending) reserve(this.store.reserveWorkerTurnFinish({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: "Completed" }));
    } else if (rendered.page && facts.latestContent?.content !== rendered.page) {
      reserve(this.store.reserveWorkerTurnContent({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, elementId: page.elementId, content: rendered.page, sourceEnd: rendered.nextPageStart ?? rendered.sourceLength }));
    } else if (rendered.nextPageStart !== null && !facts.finishPending) {
      reserve(this.reserveContinuation(view, page, rendered.nextPageStart));
    } else if (!facts.finishPending) {
      reserve(this.store.reserveWorkerTurnFinish({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: "Completed" }));
    }
    if (reserved) this.wakeOutbound();
    this.log(turnId, page.pageIndex, "content", reserved ? "reserved" : "waiting");
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
      }, { initialContent: this.presentation.workerTurnPage(view, nextPageStart, this.pageLimit).page })
    });
  }

  private log(turnId: string, pageIndex: number, action: string, outcome: string): void {
    this.logger?.debug({ event: "worker-turn-card-converged", turnId, pageIndex, action, outcome }, "planned durable Worker Task Card delivery");
  }
}

function terminalSummary(phase: string): string {
  if (phase === "failed") return "Failed";
  if (phase === "cancelled") return "Cancelled";
  return "Dispatch uncertain";
}
