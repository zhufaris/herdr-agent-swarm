import type { Logger } from "pino";
import type { OutboundWorkClass } from "../domain/types.js";
import { planAnswerPage, type AnswerPagePlanningPort } from "../domain/answer-page-plan.js";
import { answerElementId } from "../domain/run-card-view.js";
import type { AnswerPageStore } from "../domain/ports/projection.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";

export interface AnswerPageWorkflowPort { converge(promptId: string, workClass?: OutboundWorkClass): Promise<void>; }

export class AnswerPageWorkflow implements AnswerPageWorkflowPort {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly planning: AnswerPagePlanningPort;
  constructor(
    private readonly store: AnswerPageStore,
    private readonly wakeOutbound: () => void,
    private readonly presentation: Pick<PrimaryPresentation, "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage">,
    private readonly logger?: Logger,
    planning?: AnswerPagePlanningPort
  ) { this.planning = planning ?? { pageLimit: 9_000, answerStreamContent: presentation.answerStreamContent, renderAnswerStreamPage: presentation.answerStreamPage }; }

  converge(promptId: string, workClass?: OutboundWorkClass): Promise<void> {
    const previous = this.tails.get(promptId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.convergeOnce(promptId, workClass));
    const tail = work.catch(() => undefined);
    this.tails.set(promptId, tail);
    void tail.then(() => { if (this.tails.get(promptId) === tail) this.tails.delete(promptId); });
    return work;
  }

  private async convergeOnce(promptId: string, workClass?: OutboundWorkClass): Promise<void> {
    const view = this.store.loadRunCard(promptId);
    const page = this.store.getActiveAnswerPage(promptId);
    if (!view?.answerCardId) return;
    if (!page) {
      const pages = this.store.listAnswerPages(view.promptId);
      const latest = pages.at(-1);
      const previous = latest?.state === "creating" && latest.deliveryMode === "static" ? pages.at(-2) : latest;
      if (previous?.state === "frozen" && previous.deliveryMode === "static") this.reserveStaticAnswerReplacement(view, workClass);
      else this.reserveFinalFoldedCard(view, workClass);
      return;
    }
    if (!page.cardId) { this.reserveClosedAnswerCard(view, workClass); return; }
    if (page.deliveryMode === "static") { this.reserveStaticAnswerCard(view, page, workClass); return; }
    const facts = this.store.getAnswerPageDeliveryFacts(promptId, page.pageIndex);
    if (facts.finalUpdateState === "pending") return;
    if (facts.finalUpdateState === "dead_letter" || facts.finalUpdateState === "dismissed") { this.reserveFinalizedPageCard(view, page, workClass); return; }
    const plan = planAnswerPage(view, page, facts, this.planning);
    let outcome: "reserved" | "waiting" | "stale" = "waiting";
    if (plan.type === "stream-content") {
      outcome = this.store.reserveAnswerContent({ promptId, pageIndex: page.pageIndex, cardId: page.cardId, elementId: page.elementId, content: plan.content, source: plan.source, workClass });
    }
    else if (plan.type === "finish-terminal") outcome = this.store.reserveAnswerFinish({
      promptId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId!, summary: plan.summary,
      finalizedCard: this.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: this.presentation.finalAnswerPage(this.presentation.answerStreamContent(view), page.sourceStart).page })!, workClass
    });
    else if (plan.type === "continue") {
      const binding = this.store.getBinding(view.bindingId);
      if (!binding?.rootMessageId) return;
      outcome = this.store.reserveAnswerContinuation({
        promptId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId!, summary: plan.currentSummary,
        finalizedCard: this.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: this.presentation.finalAnswerPage(this.presentation.answerStreamContent(view), page.sourceStart, plan.nextPageStart).page })!,
        nextPageIndex: plan.nextPageIndex, nextPageStart: plan.nextPageStart, nextElementId: plan.nextElementId,
        rootMessageId: binding.rootMessageId, viewVersion: view.viewVersion,
        card: this.presentation.answerCard({ ...view, answerElementId: plan.nextElementId }, { pageNumber: plan.nextPageIndex + 1, initialContent: plan.initialContent, streaming: true }), workClass
      });
    } else if (plan.type === "rebuild") {
      const binding = this.store.getBinding(view.bindingId);
      if (!binding?.rootMessageId) return;
      outcome = this.store.reserveAnswerRebuild({
        promptId, pageIndex: page.pageIndex, nextPageIndex: plan.nextPageIndex, sourceStart: plan.nextPageStart, nextElementId: plan.nextElementId,
        rootMessageId: binding.rootMessageId, viewVersion: view.viewVersion,
        card: this.presentation.answerCard({ ...view, answerElementId: plan.nextElementId }, { pageNumber: plan.nextPageIndex + 1, initialContent: plan.initialContent, streaming: true }), workClass
      });
    }
    if (outcome === "reserved") this.wakeOutbound();
    this.reserveFinalFoldedCard(view, workClass);
    if (plan.type !== "wait") this.logger?.debug({ event: "answer-page-converged", promptId, bindingId: view.bindingId, pageIndex: page.pageIndex, action: plan.type, outcome }, "planned durable Answer page delivery");
  }

  private reserveFinalFoldedCard(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>, workClass?: OutboundWorkClass): void {
    if (view.phase !== "completed") return;
    const finished = this.store.listAnswerPages(view.promptId).at(-1);
    if (!finished || finished.state !== "finished" || !finished.cardId || !finished.messageId) return;
    const rendered = this.presentation.finalAnswerPage(this.presentation.answerStreamContent(view), finished.sourceStart).page;
    const latestContent = this.store.getAnswerPageDeliveryFacts(view.promptId, finished.pageIndex).latestContent;
    const content = rendered || (latestContent?.state === "delivered" ? latestContent.content : "");
    const card = this.presentation.finalAnswer(view, { pageNumber: finished.pageIndex + 1, initialContent: content });
    if (card && this.store.reserveFinalAnswerCardUpdate({ promptId: view.promptId, pageIndex: finished.pageIndex, cardId: finished.cardId, messageId: finished.messageId, card, workClass }) === "reserved") this.wakeOutbound();
  }

  private reserveFinalizedPageCard(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>, page: ReturnType<AnswerPageStore["listAnswerPages"]>[number], workClass?: OutboundWorkClass): void {
    if (!page.cardId || !page.messageId) return;
    const pages = this.store.listAnswerPages(view.promptId);
    const next = pages.find(({ pageIndex }) => pageIndex === page.pageIndex + 1);
    const content = this.presentation.finalAnswerPage(this.presentation.answerStreamContent(view), page.sourceStart, next?.sourceStart).page;
    const card = this.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: content });
    if (card && this.store.reserveFinalAnswerCardUpdate({ promptId: view.promptId, pageIndex: page.pageIndex, cardId: page.cardId, messageId: page.messageId, card, workClass }) === "reserved") this.wakeOutbound();
  }

  private reserveClosedAnswerCard(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>, workClass?: OutboundWorkClass): void {
    const page = this.store.listAnswerPages(view.promptId).at(-1);
    if (!page || page.state !== "finished" || !page.messageId) return;
    const rendered = this.presentation.answerStreamPage(this.presentation.answerStreamContent(view), page.sourceStart).page;
    const latestContent = this.store.getAnswerPageDeliveryFacts(view.promptId, page.pageIndex).latestContent;
    const content = rendered || (latestContent?.state === "delivered" ? latestContent.content : "");
    const card = view.phase === "completed"
      ? this.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: content })
      : this.presentation.answerCard(view, { pageNumber: page.pageIndex + 1, initialContent: content, streaming: false });
    if (card && this.store.reserveClosedAnswerCardUpdate({ promptId: view.promptId, pageIndex: page.pageIndex, messageId: page.messageId, card, workClass }) === "reserved") this.wakeOutbound();
  }

  private reserveStaticAnswerCard(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>, page: NonNullable<ReturnType<AnswerPageStore["getActiveAnswerPage"]>>, workClass?: OutboundWorkClass): void {
    if (!page.messageId) return;
    const source = this.presentation.answerStreamContent(view);
    const rendered = this.presentation.answerStreamPage(source, page.sourceStart);
    const card = view.phase === "completed"
      ? this.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: rendered.page })
      : this.presentation.answerCard(view, { pageNumber: page.pageIndex + 1, initialContent: rendered.page, streaming: false });
    if (card && this.store.reserveStaticAnswerCardUpdate({ promptId: view.promptId, pageIndex: page.pageIndex, messageId: page.messageId, card, source: source.slice(page.sourceStart, rendered.nextPageStart ?? source.length), workClass }) === "reserved") this.wakeOutbound();
  }

  private reserveStaticAnswerReplacement(view: NonNullable<ReturnType<AnswerPageStore["loadRunCard"]>>, workClass?: OutboundWorkClass): void {
    const pages = this.store.listAnswerPages(view.promptId);
    const latest = pages.at(-1);
    const previous = latest?.state === "creating" && latest.deliveryMode === "static" ? pages.at(-2) : latest;
    const binding = this.store.getBinding(view.bindingId);
    if (!previous || previous.state !== "frozen" || previous.deliveryMode !== "static" || !binding?.rootMessageId) return;
    const nextPageIndex = latest?.state === "creating" && latest.deliveryMode === "static" ? latest.pageIndex : previous.pageIndex + 1;
    const nextElementId = answerElementId(view.promptId, nextPageIndex);
    const content = this.presentation.answerStreamPage(this.presentation.answerStreamContent(view), previous.sourceStart).page;
    const card = view.phase === "completed"
      ? this.presentation.finalAnswer(view, { pageNumber: nextPageIndex + 1, initialContent: content, answerElementId: nextElementId })
      : this.presentation.answerCard({ ...view, answerElementId: nextElementId }, { pageNumber: nextPageIndex + 1, initialContent: content, streaming: false });
    if (card && this.store.reserveStaticAnswerReplacement({ promptId: view.promptId, previousPageIndex: previous.pageIndex, nextPageIndex, sourceStart: previous.sourceStart, nextElementId, rootMessageId: binding.rootMessageId, viewVersion: view.viewVersion, card, workClass }) === "reserved") this.wakeOutbound();
  }
}
