import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import { planAnswerPage } from "../domain/answer-page-plan.js";
import type { AnswerPageStore } from "../domain/ports.js";

export interface AnswerPageWorkflowPort { converge(promptId: string): Promise<void>; }

export class AnswerPageWorkflow implements AnswerPageWorkflowPort {
  private readonly tails = new Map<string, Promise<void>>();
  constructor(
    private readonly store: AnswerPageStore,
    private readonly wakeOutbound: () => void,
    private readonly logger?: Logger
  ) {}

  converge(promptId: string): Promise<void> {
    const previous = this.tails.get(promptId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.convergeOnce(promptId));
    const tail = work.catch(() => undefined);
    this.tails.set(promptId, tail);
    void tail.then(() => { if (this.tails.get(promptId) === tail) this.tails.delete(promptId); });
    return work;
  }

  private async convergeOnce(promptId: string): Promise<void> {
    const view = this.store.loadRunCard(promptId);
    const page = this.store.getActiveAnswerPage(promptId);
    if (!view?.answerCardId || !page?.cardId) return;
    const plan = planAnswerPage(view, page, this.store.getAnswerPageDeliveryFacts(promptId, page.pageIndex));
    let outcome: "reserved" | "waiting" | "stale" = "waiting";
    if (plan.type === "stream-content") outcome = this.store.reserveAnswerContent({ promptId, pageIndex: page.pageIndex, cardId: page.cardId, elementId: page.elementId, content: plan.content });
    else if (plan.type === "finish-terminal") outcome = this.store.reserveAnswerFinish({ promptId, pageIndex: page.pageIndex, cardId: page.cardId, summary: plan.summary });
    else if (plan.type === "continue") {
      const binding = this.store.getBinding(view.bindingId);
      if (!binding?.rootMessageId) return;
      outcome = this.store.reserveAnswerContinuation({
        promptId, pageIndex: page.pageIndex, cardId: page.cardId, summary: plan.currentSummary,
        nextPageIndex: plan.nextPageIndex, nextPageStart: plan.nextPageStart, nextElementId: plan.nextElementId,
        rootMessageId: binding.rootMessageId, viewVersion: view.viewVersion,
        card: renderRequestAnswerCard({ ...view, answerElementId: plan.nextElementId }, { pageNumber: plan.nextPageIndex + 1, initialContent: plan.initialContent, streaming: true })
      });
    }
    if (outcome === "reserved") this.wakeOutbound();
    if (plan.type !== "wait") this.logger?.debug({ event: "answer-page-converged", promptId, bindingId: view.bindingId, pageIndex: page.pageIndex, action: plan.type, outcome }, "planned durable Answer page delivery");
  }
}
