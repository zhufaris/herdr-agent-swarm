import type { AnswerPageStore, MainCardStore } from "../domain/ports/projection.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { PrimaryCardRedelivery, PrimaryCardRedeliveryReservation, PrimaryCardRedeliverySnapshot, PrimaryCardRedeliveryStore } from "../domain/ports/primary-card-redelivery.js";
import { projectionGapWarning } from "../domain/projection-gap.js";
import { lateAnswerTimelineResults } from "../domain/answer-timeline-late-results.js";

type MainGapStore = Pick<MainCardStore, "getProjectionGapSummary">;
type AnswerRenderStore = Pick<AnswerPageStore, "getProjectionGapSummary" | "getAnswerTimelinePage" | "listFrozenAnswerTimelineItems">;
type RedeliveryPresentation = Pick<PrimaryPresentation,
  "mainCard" | "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage" | "answerTimelinePage">;

export class PrimaryCardRedeliveryWorkflow implements PrimaryCardRedelivery {
  constructor(private readonly options: {
    store: PrimaryCardRedeliveryStore;
    mainCards: Partial<MainGapStore>;
    answerPages: Partial<AnswerRenderStore>;
    presentation: RedeliveryPresentation;
    wakeOutbound: () => void;
    answerPageLimit: number;
  }) {}

  redeliver(input: { commandIntentId: string; bindingId: string; expectedBindingGeneration: number }): PrimaryCardRedeliveryReservation {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = this.options.store.loadSnapshot(input);
      if (snapshot.outcome !== "available") return snapshot;
      const mainGapWarning = projectionGapWarning(this.options.mainCards.getProjectionGapSummary?.({ bindingId: input.bindingId }));
      const mainCard = this.options.presentation.mainCard(snapshot.topic, { gapWarning: mainGapWarning });
      const answerCard = snapshot.answer ? this.renderAnswer(snapshot) : null;
      if (snapshot.answer && !answerCard) return { outcome: "unavailable", reason: "answer_render_unavailable" };
      const reserved = this.options.store.reserve({ commandIntentId: input.commandIntentId, snapshot, mainCard, answerCard });
      if (reserved.outcome === "stale" && attempt === 0) continue;
      if (reserved.outcome === "scheduled") this.options.wakeOutbound();
      return reserved;
    }
    return { outcome: "stale", reason: "projection_changed" };
  }

  private renderAnswer(snapshot: PrimaryCardRedeliverySnapshot): object | null {
    const selected = snapshot.answer!;
    const { page } = selected;
    const view = {
      ...selected.run,
      answerMessageId: page.messageId,
      answerCardId: page.cardId,
      answerElementId: page.elementId,
      answerPageIndex: page.pageIndex,
      answerPageStart: page.sourceStart
    };
    const gapWarning = projectionGapWarning(this.options.answerPages.getProjectionGapSummary?.({
      bindingId: view.bindingId, promptId: view.promptId, pageIndex: page.pageIndex
    }));
    if (view.timelineItems.length > 0 && this.options.answerPages.getAnswerTimelinePage) {
      const checkpoint = this.options.answerPages.getAnswerTimelinePage(view.promptId, page.pageIndex);
      const prefixItems = this.options.answerPages.listFrozenAnswerTimelineItems
        ? lateAnswerTimelineResults(view.timelineItems, this.options.answerPages.listFrozenAnswerTimelineItems(view.promptId, page.pageIndex))
        : [];
      const planned = this.options.presentation.answerTimelinePage(view.timelineItems, checkpoint.startCursor, this.options.answerPageLimit, prefixItems);
      return view.phase === "completed" && page.state === "finished"
        ? this.options.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: "", timelineItems: planned.items, gapWarning, completionActions: selected.completionActions })
        : this.options.presentation.answerCard(view, { pageNumber: page.pageIndex + 1, streaming: page.state === "active" && page.deliveryMode === "streaming", timelineItems: planned.items, gapWarning });
    }

    const source = this.options.presentation.answerStreamContent(view);
    const content = page.state === "finished"
      ? this.options.presentation.finalAnswerPage(source, page.sourceStart, selected.nextPageStart ?? undefined).page
      : this.options.presentation.answerStreamPage(source, page.sourceStart, this.options.answerPageLimit).page;
    return view.phase === "completed" && page.state === "finished"
      ? this.options.presentation.finalAnswer(view, { pageNumber: page.pageIndex + 1, initialContent: content, gapWarning, completionActions: selected.completionActions })
      : this.options.presentation.answerCard(view, {
        pageNumber: page.pageIndex + 1,
        initialContent: content,
        streaming: page.state === "active" && page.deliveryMode === "streaming",
        gapWarning
      });
  }
}
