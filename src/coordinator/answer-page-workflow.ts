import type { Logger } from "pino";
import { renderFinalAnswerCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { answerStreamContent, renderAnswerStreamPage } from "../runtime/answer-stream.js";
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
    if (!view?.answerCardId) return;
    if (!page?.cardId) { this.reserveFinalFoldedCard(view); return; }
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
    } else if (plan.type === "rebuild") {
      const binding = this.store.getBinding(view.bindingId);
      if (!binding?.rootMessageId) return;
      outcome = this.store.reserveAnswerRebuild({
        promptId, pageIndex: page.pageIndex, nextPageIndex: plan.nextPageIndex, sourceStart: plan.nextPageStart, nextElementId: plan.nextElementId,
        rootMessageId: binding.rootMessageId, viewVersion: view.viewVersion,
        card: renderRequestAnswerCard({ ...view, answerElementId: plan.nextElementId }, { pageNumber: plan.nextPageIndex + 1, initialContent: plan.initialContent, streaming: true })
      });
    }
    if (outcome === "reserved") this.wakeOutbound();
    this.reserveFinalFoldedCard(view);
    if (plan.type !== "wait") this.logger?.debug({ event: "answer-page-converged", promptId, bindingId: view.bindingId, pageIndex: page.pageIndex, action: plan.type, outcome }, "planned durable Answer page delivery");
  }

  private reserveFinalFoldedCard(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>): void {
    if (view.phase !== "completed") return;
    const finished = this.store.listAnswerPages(view.promptId).at(-1);
    if (!finished || finished.state !== "finished" || !finished.cardId || !finished.messageId) return;
    const content = renderAnswerStreamPage(answerStreamContent(view), finished.sourceStart).page;
    const card = renderFinalAnswerCard(view, { pageNumber: finished.pageIndex + 1, initialContent: content });
    if (card && this.store.reserveFinalAnswerCardUpdate({ promptId: view.promptId, pageIndex: finished.pageIndex, cardId: finished.cardId, messageId: finished.messageId, card }) === "reserved") this.wakeOutbound();
  }
}
