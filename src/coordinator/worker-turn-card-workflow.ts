import type { Logger } from "pino";
import { renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import { workerTurnElementId, workerTurnStreamContent } from "../domain/worker-turn-card-view.js";
import type { WorkerTurnCardStore } from "../domain/ports/projection.js";
import { renderLarkMarkdownPage } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";

const PAGE_LIMIT = 9_000;

export interface WorkerTurnCardWorkflowPort { converge(turnId: string): Promise<void>; }

export class WorkerTurnCardWorkflow implements WorkerTurnCardWorkflowPort {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly store: WorkerTurnCardStore, private readonly wakeOutbound: () => void, private readonly logger?: Logger) {}

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
    if (!view) return;
    if (!view.cardId || !view.messageId) {
      if (this.store.listPendingOutboundReplies().some((reply) => reply.workerTurnId === turnId)) this.wakeOutbound();
      return;
    }
    const page = this.store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === view.pageIndex && candidate.state === "active");
    if (!page?.cardId) return;
    const content = redactSecrets(workerTurnStreamContent(view));
    const rendered = renderLarkMarkdownPage(content, page.pageStart, PAGE_LIMIT);
    const facts = this.store.getWorkerTurnCardDeliveryFacts(turnId, page.pageIndex);
    if (facts.continuationPending || facts.latestContent?.state === "pending" || facts.latestContent?.state === "dead_letter") return;
    let outcome: "reserved" | "waiting" | "stale" = "waiting";
    if (facts.latestContent?.content !== rendered.page && rendered.page) {
      outcome = this.store.reserveWorkerTurnContent({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, elementId: page.elementId, content: rendered.page, sourceEnd: rendered.nextPageStart ?? content.length });
    } else if (rendered.nextPageStart !== null) {
      const nextPageIndex = page.pageIndex + 1;
      const nextElementId = workerTurnElementId(turnId, nextPageIndex);
      const nextPage = { id: `${turnId}:${nextPageIndex}`, turnId, pageIndex: nextPageIndex, pageStart: rendered.nextPageStart, elementId: nextElementId, messageId: null, cardId: null, state: "creating" as const, sequence: 0, createdAt: view.updatedAt, updatedAt: view.updatedAt };
      outcome = this.store.reserveWorkerTurnContinuation({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: `结果将在第 ${nextPageIndex + 1} 页继续`, nextPageIndex, nextPageStart: rendered.nextPageStart, nextElementId, rootMessageId: view.rootMessageId, viewVersion: view.viewVersion, card: renderWorkerTurnCard({ ...view, pageIndex: nextPageIndex, pageStart: rendered.nextPageStart, elementId: nextElementId }, nextPage) });
    } else if (["completed", "failed", "cancelled"].includes(view.phase) && !facts.finishPending) {
      outcome = this.store.reserveWorkerTurnFinish({ turnId, pageIndex: page.pageIndex, cardId: page.cardId, summary: view.phase === "completed" ? "Completed" : "Finished" });
    }
    if (outcome === "reserved") this.wakeOutbound();
    if (outcome !== "waiting") this.logger?.debug({ event: "worker-turn-card-converged", turnId, pageIndex: page.pageIndex, outcome }, "planned durable Worker card delivery");
  }
}
