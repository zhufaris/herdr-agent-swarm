import type { Logger } from "pino";
import type { OutboundWorkClass } from "../domain/types.js";
import type { ActiveConversationSegmentProjection, ConversationSegmentStore, SemanticConversationPageReservation } from "../domain/ports/conversation-segment.js";
import type { ApplicationPresentation, ConversationPagePresentationPolicy, TurnCardRenderOptions } from "../domain/ports/presentation.js";
import { turnCardProjectionKey } from "../domain/turn-card-projection-key.js";
import type { AnswerTimelineCursor, PresentationSnapshot } from "../domain/delivery.js";
import type { ConversationSegmentCursorAnchor } from "../domain/ports/conversation-segment.js";
import type { SessionActivityStore } from "../domain/ports/session-activity.js";
import { createHash } from "node:crypto";

/** Durable convergence for every canonical human segment. Keys are deliberately segment IDs. */
export class TurnCardWorkflow {
  private readonly tails = new Map<string, Promise<void>>();
  constructor(private readonly store: ConversationSegmentStore, private readonly wakeOutbound: () => void, private readonly presentation: Pick<ApplicationPresentation, "turnCardPage"> & Partial<Pick<ApplicationPresentation, "completionReview">>, private readonly payloadLimit = 9_000, private readonly logger?: Pick<Logger, "debug" | "warn">, private readonly sessionActivity?: Pick<SessionActivityStore, "loadTurnSessionStateForCurrentSegment">, private readonly semanticPolicy?: ConversationPagePresentationPolicy<PresentationSnapshot, unknown>, private readonly gatewayProfileVersion = 1, private readonly lateRecoveryCardsEnabled = true) {}

  async convergeActionable(): Promise<readonly string[]> {
    const failed: string[] = [];
    for (const id of this.store.listActionableConversationSegmentIds()) {
      try { await this.converge(id); } catch (error) { failed.push(id); this.logger?.warn({ event: "turn-card-convergence-failed", segmentId: id, error }, "failed to converge Turn Card"); }
    }
    return failed;
  }

  async recoverNextHistoricalMissingCard(): Promise<"reserved" | "stale" | "none"> {
    const candidate = this.store.listHistoricalMissingPageCandidates?.({ limit: 1 })[0];
    if (!candidate || !this.store.reserveHistoricalMissingPage) return "none";
    const view = this.store.loadCardView(candidate.segmentId);
    const page = this.store.listConversationSegmentPages(candidate.segmentId).find(({ pageIndex }) => pageIndex === candidate.pageIndex);
    if (!view || !page || page.elementId !== candidate.elementId) return "stale";
    const planned = this.presentation.turnCardPage(view, {
      pageIndex: candidate.pageIndex,
      elementId: candidate.elementId,
      startCursor: candidate.startCursor
    }, { continuation: candidate.pageIndex > 0 }, this.payloadLimit);
    return this.store.reserveHistoricalMissingPage({ candidate, card: planned.card, cursor: planned.nextCursor });
  }

  converge(segmentId: string, workClass?: OutboundWorkClass): Promise<void> {
    const previous = this.tails.get(segmentId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.convergeOnce(segmentId, workClass));
    const tail = work.catch(() => undefined);
    this.tails.set(segmentId, tail);
    void tail.then(() => { if (this.tails.get(segmentId) === tail) this.tails.delete(segmentId); });
    return work;
  }

  private convergeOnce(segmentId: string, workClass?: OutboundWorkClass): void {
    const notification = this.store.recoverPrimarySegmentCompletionNotification?.(segmentId);
    if (notification?.outcome === "released") this.wakeOutbound();
    else if (notification?.outcome === "not_ready" && notification.reason !== "missing_obligation") {
      this.logger?.debug({ event: "segment-completion-notification-not-ready", segmentId, reason: notification.reason }, "completion notification is not ready for recovery");
    }
    let projection = typeof (this.store as { loadActiveProjection?: unknown }).loadActiveProjection === "function"
      ? this.store.loadActiveProjection(segmentId)
      : this.loadLegacyTestProjection(segmentId);
    if (!projection) return;
    let view = projection.view;
    const lateRecovery = this.lateRecoveryCardsEnabled ? this.store.nextLateItemRecovery?.(segmentId) : null;
    if (lateRecovery && this.store.reserveLateItemRecovery) {
      const recoveryView = {
        ...view,
        state: "completed" as const,
        timelineItems: [lateRecovery.item],
        gapWarning: "检测到早于当前页游标的活动；以下内容按 canonical timeline 顺序恢复，既有页面保持不变。"
      };
      const planned = this.presentation.turnCardPage(recoveryView, {
        pageIndex: lateRecovery.partIndex,
        elementId: lateRecovery.projectionKey,
        startCursor: lateRecovery.startCursor
      }, { continuation: true }, this.payloadLimit);
      const outcome = this.store.reserveLateItemRecovery({
        ...lateRecovery, card: planned.card, nextCursor: planned.nextCursor,
        ...(workClass ? { workClass } : {})
      });
      if (outcome === "reserved") this.wakeOutbound();
      return;
    }
    const historical = this.store.nextHistoricalPageRecovery?.(segmentId);
    if (historical && this.store.reserveHistoricalPageRecovery) {
      const history = this.store.loadHistoryPage({ segmentId, startCursor: historical.startCursor, endCursor: historical.endCursor, limit: 500 });
      const timelineItems = history.items;
      const recoveryView = {
        ...view, state: "completed" as const, timelineItems,
        gapWarning: `历史第 ${historical.sourcePageIndex + 1} 页曾遗漏活动；以下内容按 canonical timeline 顺序恢复。`
      };
      const startOffset = historical.startCursor.offset ?? historical.startCursor.markdownOffset ?? 0;
      const localStart = startOffset > 0 ? { itemIndex: 0, markdownOffset: startOffset } : null;
      const planned = this.presentation.turnCardPage(recoveryView, {
        pageIndex: historical.sourcePageIndex, elementId: historical.projectionKey, startCursor: localStart
      }, { continuation: true }, this.payloadLimit);
      const endCursor = planned.nextCursor ? {
        ...planned.nextCursor, itemIndex: historical.startCursor.itemIndex + planned.nextCursor.itemIndex
      } : history.hasMore
        ? { itemIndex: historical.startCursor.itemIndex + history.items.length, markdownOffset: 0 }
        : historical.endCursor;
      const localEndCursor = planned.nextCursor ?? { itemIndex: history.items.length, markdownOffset: 0 };
      const endAnchor = anchorForLocalCursor(history.itemPositions, localEndCursor);
      if (!endAnchor) return;
      const outcome = this.store.reserveHistoricalPageRecovery({ ...historical, endCursor, endAnchor, card: planned.card, ...(workClass ? { workClass } : {}) });
      if (outcome === "reserved") this.wakeOutbound();
      return;
    }
    const beforeRecovery = projection.pendingPage;
    if (beforeRecovery) {
      const recovery = this.store.reconcilePageDelivery(segmentId, beforeRecovery.pageIndex);
      if (recovery === "waiting" || recovery === "stale") return;
      if (recovery === "adopted") {
        const refreshed = this.store.loadActiveProjection(segmentId);
        if (!refreshed) return;
        projection = refreshed;
        view = refreshed.view;
      }
    }
    const page = projection.page;
    if (!page) {
      const frozen = projection.latestFrozenPage;
      if (frozen?.messageId && frozen.state === "frozen") {
        const nextPageIndex = frozen.pageIndex + 1;
        const completionRender = this.store.loadCompletionRenderState?.(view.segmentId) ?? null;
        const nextPageInput = { pageIndex: nextPageIndex, elementId: turnCardProjectionKey(segmentId, nextPageIndex), startCursor: projection.localStartCursor };
        const nextOptions: TurnCardRenderOptions = {
          continuation: true,
          sessionState: this.loadCurrentSessionState(segmentId),
          completionNotice: null,
          completionNoticeBudget: completionRender ? { mentionOpenId: completionRender.mentionOpenId, reason: completionRender.reason } : null,
          completionActionsBudget: completionRender?.completionActions ?? null
        };
        const nextStartAnchor = anchorForLocalCursor(projection.itemPositions, projection.localStartCursor) ?? projection.startAnchor;
        if (!nextStartAnchor) return;
        if (frozen.deliveryCohort === "semantic") {
          if (!this.semanticPolicy || !this.store.reserveSemanticSnapshot) throw new Error("Semantic Turn Card delivery is not connected");
          const semantic = this.semanticPolicy.plan(view, nextPageInput, nextOptions, this.semanticBudget());
          const outcome = this.store.reserveSemanticSnapshot({
            transition: "continuation", segmentId, pageIndex: frozen.pageIndex, messageId: frozen.messageId,
            nextPageIndex, nextElementId: nextPageInput.elementId, nextStartCursor: frozen.deliveredCursor,
            nextStartAnchor, snapshot: semantic.snapshot,
            cursor: globalizeCursor(semantic.pagePlan.endCursor, projection.cursorBase),
            plannerPolicyVersion: this.semanticPolicy.plannerPolicyVersion,
            rendererPolicyVersion: this.semanticPolicy.rendererPolicyVersion,
            gatewayProfileVersion: this.gatewayProfileVersion,
            ...(workClass ? { workClass } : {})
          });
          if (outcome === "reserved") this.wakeOutbound();
          return;
        }
        const nextPlan = this.presentation.turnCardPage(view, nextPageInput, nextOptions, this.payloadLimit);
        const outcome = this.store.reserveLateContinuation({ segmentId, pageIndex: frozen.pageIndex, messageId: frozen.messageId, card: nextPlan.card, nextPageIndex, nextElementId: nextPageInput.elementId, nextStartCursor: frozen.deliveredCursor, nextStartAnchor, ...(workClass ? { workClass } : {}) });
        if (outcome === "reserved") this.wakeOutbound();
      }
      return;
    }
    const pageInput = { pageIndex: page.pageIndex, elementId: page.elementId, startCursor: projection.localStartCursor };
    const sessionState = this.loadCurrentSessionState(segmentId);
    const completionRender = this.store.loadCompletionRenderState?.(view.segmentId) ?? null;
    const completionNotice = completionRender ? { mentionOpenId: completionRender.mentionOpenId, reason: completionRender.reason } : null;
    const semanticReserve = this.store.reserveSemanticSnapshot;
    const options: TurnCardRenderOptions = {
      continuation: page.pageIndex > 0,
      completionNotice: null,
      completionNoticeBudget: completionNotice,
      completionActions: null,
      completionActionsBudget: completionRender?.completionActions ?? null,
      sessionState
    };
    if (page.deliveryCohort === "semantic") {
      if (!this.semanticPolicy || !semanticReserve) throw new Error("Semantic Turn Card delivery is not connected");
      const semantic = this.semanticPolicy.plan(view, pageInput, options, this.semanticBudget());
      let reservation: SemanticConversationPageReservation;
      if (page.messageId && semantic.pagePlan.hasContinuation && semantic.pagePlan.endCursor) {
        const frozen = sessionState
          ? this.semanticPolicy.plan({ ...view, state: "completed" }, pageInput, { continuation: page.pageIndex > 0 }, this.semanticBudget())
          : completionRender
            ? semantic
            : this.semanticPolicy.plan({ ...view, state: "completed" }, pageInput, { continuation: page.pageIndex > 0 }, this.semanticBudget());
        const frozenLocalCursor = frozen.pagePlan.endCursor ?? { itemIndex: projection.itemPositions.length, markdownOffset: 0 };
        const cursorAnchor = anchorForLocalCursor(projection.itemPositions, frozenLocalCursor);
        if (!cursorAnchor) return;
        reservation = {
          transition: "freeze", segmentId, pageIndex: page.pageIndex, messageId: page.messageId,
          ...(page.cardId !== null ? { cardId: page.cardId } : {}), elementId: page.elementId,
          snapshot: frozen.snapshot, cursor: globalizeCursor(frozenLocalCursor, projection.cursorBase)!,
          cursorAnchor,
          plannerPolicyVersion: this.semanticPolicy.plannerPolicyVersion,
          rendererPolicyVersion: this.semanticPolicy.rendererPolicyVersion,
          gatewayProfileVersion: this.gatewayProfileVersion,
          ...(workClass ? { workClass } : {})
        };
      } else if (page.messageId && ["completed", "failed", "cancelled", "needs_human", "closed"].includes(view.state)) {
        const freshReview = this.reserveFreshCompletionReview(view, page.pageIndex, page.cardId, page.messageId, completionRender);
        const completionActions = freshReview ? null : completionRender?.completionActions ?? null;
        const finalCompletionNotice = freshReview
          ? completionRender?.reason === "final_request" ? completionNotice : null
          : completionRender && (completionActions || completionRender.reason === "final_request")
            ? completionNotice
            : completionRender?.reason === "both"
              ? { mentionOpenId: completionRender.mentionOpenId, reason: "final_request" as const }
              : null;
        const final = this.semanticPolicy.plan(view, pageInput, {
          continuation: page.pageIndex > 0, completionNotice: finalCompletionNotice, completionActions, sessionState
        }, this.semanticBudget());
        if (final.pagePlan.hasContinuation || final.pagePlan.endCursor) throw new Error("Completion presentation pagination budget diverged from final Turn Card");
        reservation = {
          transition: "finish", segmentId, pageIndex: page.pageIndex, messageId: page.messageId,
          ...(page.cardId !== null ? { cardId: page.cardId } : {}), elementId: page.elementId,
          snapshot: final.snapshot, summary: terminalSummary(view.state),
          cursor: terminalCursor(projection),
          plannerPolicyVersion: this.semanticPolicy.plannerPolicyVersion,
          rendererPolicyVersion: this.semanticPolicy.rendererPolicyVersion,
          gatewayProfileVersion: this.gatewayProfileVersion,
          ...(workClass ? { workClass } : {})
        };
      } else {
        reservation = {
          transition: "snapshot", segmentId, pageIndex: page.pageIndex, messageId: page.messageId, snapshot: semantic.snapshot,
          cursor: globalizeCursor(semantic.pagePlan.endCursor, projection.cursorBase), viewVersion: view.viewVersion,
          elementId: page.elementId, ...(page.cardId !== null ? { cardId: page.cardId } : {}),
          plannerPolicyVersion: this.semanticPolicy.plannerPolicyVersion,
          rendererPolicyVersion: this.semanticPolicy.rendererPolicyVersion,
          gatewayProfileVersion: this.gatewayProfileVersion,
          ...(workClass ? { workClass } : {})
        };
      }
      const outcome = semanticReserve.call(this.store, reservation);
      if (outcome === "reserved") this.wakeOutbound();
      return;
    }
    const planned = this.presentation.turnCardPage(view, pageInput, options, this.payloadLimit);
    const globalNextCursor = globalizeCursor(planned.nextCursor, projection.cursorBase);
    const rolloutStore = this.store as ConversationSegmentStore & {
      getSemanticDeliveryRolloutPhase?: () => "expansion"|"shadow"|"cohort"|"contraction_ready";
      recordSemanticDeliveryShadowEvidence?: (input: { segmentId:string; pageIndex:number; viewVersion:number; snapshotSchemaVersion:number; plannerPolicyVersion:number; rendererPolicyVersion:number; gatewayProfileVersion:number; legacyFingerprint:string; semanticFingerprint:string; matched:boolean; details:Readonly<Record<string, unknown>> }) => void;
    };
    let recordShadowEvidence: (()=>void)|null = null;
    if (!page.messageId && this.semanticPolicy
      && rolloutStore.getSemanticDeliveryRolloutPhase?.() === "shadow" && rolloutStore.recordSemanticDeliveryShadowEvidence
      && this.store.previewSemanticShadowDelivery && this.store.loadLegacyShadowDelivery) {
      const semantic = this.semanticPolicy.plan(view, pageInput, options, {
        encodedBytes: this.payloadLimit, elementCount: 256, actionCount: 32, profileVersion: this.gatewayProfileVersion
      });
      const semanticReservation: SemanticConversationPageReservation = {
        transition: "snapshot", segmentId, pageIndex: page.pageIndex, messageId: null,
        snapshot: semantic.snapshot, cursor: globalizeCursor(semantic.pagePlan.endCursor, projection.cursorBase),
        viewVersion: view.viewVersion, elementId: page.elementId,
        plannerPolicyVersion: this.semanticPolicy.plannerPolicyVersion,
        rendererPolicyVersion: this.semanticPolicy.rendererPolicyVersion,
        gatewayProfileVersion: this.gatewayProfileVersion,
        ...(workClass ? { workClass } : {})
      };
      const semanticDelivery = this.store.previewSemanticShadowDelivery(semanticReservation);
      recordShadowEvidence=()=>{
        const legacyDelivery = this.store.loadLegacyShadowDelivery!(segmentId, page.pageIndex, view.viewVersion, {
          policyVersion: semantic.pagePlan.policyVersion,
          budgetProfileVersion: semantic.pagePlan.budgetProfileVersion,
          pageIndex: page.pageIndex,
          startCursor: pageInput.startCursor ?? null,
          endCursor: planned.nextCursor,
          hasContinuation: planned.nextCursor !== null
        });
        if (!legacyDelivery || !semanticDelivery) return;
        const comparison = this.semanticPolicy!.compareLegacyPresentation({ legacyView: planned.card, semanticSnapshot: semantic.snapshot, legacyDelivery, semanticDelivery });
        rolloutStore.recordSemanticDeliveryShadowEvidence!({
          segmentId,pageIndex:page.pageIndex,viewVersion:view.viewVersion,
          snapshotSchemaVersion:Number(semantic.snapshot.schemaVersion),
          plannerPolicyVersion:this.semanticPolicy!.plannerPolicyVersion,rendererPolicyVersion:this.semanticPolicy!.rendererPolicyVersion,gatewayProfileVersion:this.gatewayProfileVersion,
          legacyFingerprint:parityFingerprint(comparison.legacy),semanticFingerprint:parityFingerprint(comparison.semantic),matched:comparison.matched,
          details:{ legacy:comparison.legacy,semantic:comparison.semantic,mismatches:comparison.mismatches.slice(0,16) }
        });
      };
    }
    if (!page.messageId) {
      const outcome = this.store.reserveSnapshot({ segmentId, pageIndex: page.pageIndex, messageId: null, card: planned.card, cursor: globalNextCursor, viewVersion: view.viewVersion, elementId: page.elementId, cardId: null, ...(workClass ? { workClass } : {}) });
      if (outcome === "reserved") { recordShadowEvidence?.(); this.wakeOutbound(); }
      return;
    }
    if (planned.nextCursor && globalNextCursor) {
      const frozen = sessionState
        ? this.presentation.turnCardPage({ ...view, state: "completed" }, pageInput, { continuation: page.pageIndex > 0 }, this.payloadLimit)
        : completionRender
          ? planned
          : this.presentation.turnCardPage({ ...view, state: "completed" }, pageInput, { continuation: page.pageIndex > 0 }, this.payloadLimit);
      const frozenLocalCursor = frozen.nextCursor ?? { itemIndex: projection.itemPositions.length, markdownOffset: 0 };
      const frozenGlobalCursor = globalizeCursor(frozenLocalCursor, projection.cursorBase)!;
      const outcome = this.store.reserveFreeze({
        segmentId, pageIndex: page.pageIndex, messageId: page.messageId, card: frozen.card,
        cursor: frozenGlobalCursor, cursorAnchor: anchorForLocalCursor(projection.itemPositions, frozenLocalCursor)!, elementId: page.elementId,
        ...(page.cardId !== null ? { cardId: page.cardId } : {}), ...(workClass ? { workClass } : {})
      });
      if (outcome === "reserved") this.wakeOutbound();
      return;
    }
    if (["completed", "failed", "cancelled", "needs_human", "closed"].includes(view.state)) {
      const freshReview = this.reserveFreshCompletionReview(view, page.pageIndex, page.cardId, page.messageId, completionRender);
      const completionActions = freshReview ? null : completionRender?.completionActions ?? null;
      const finalCompletionNotice = freshReview
        ? completionRender?.reason === "final_request" ? completionNotice : null
        : completionRender && (completionActions || completionRender.reason === "final_request")
          ? completionNotice
          : completionRender?.reason === "both"
            ? { mentionOpenId: completionRender.mentionOpenId, reason: "final_request" as const }
            : null;
      const finalPlan = completionRender
        ? this.presentation.turnCardPage(view, pageInput, { continuation: page.pageIndex > 0, completionNotice: finalCompletionNotice, completionActions, sessionState }, this.payloadLimit)
        : planned;
      if (finalPlan.nextCursor) throw new Error("Completion presentation pagination budget diverged from final Turn Card");
      const outcome = this.store.reserveFinish({ segmentId, pageIndex: page.pageIndex, messageId: page.messageId, card: finalPlan.card, summary: terminalSummary(view.state), cursor: terminalCursor(projection), elementId: page.elementId, ...(page.cardId !== null ? { cardId: page.cardId } : {}), ...(workClass ? { workClass } : {}) });
      if (outcome === "reserved") this.wakeOutbound();
      return;
    }
    const outcome = this.store.reserveSnapshot({ segmentId, pageIndex: page.pageIndex, messageId: page.messageId, card: planned.card, cursor: globalNextCursor, viewVersion: view.viewVersion, elementId: page.elementId, ...(page.cardId !== null ? { cardId: page.cardId } : {}), ...(workClass ? { workClass } : {}) });
    if (outcome === "reserved") this.wakeOutbound();
  }

  private loadCurrentSessionState(segmentId: string) {
    return this.sessionActivity?.loadTurnSessionStateForCurrentSegment(segmentId) ?? null;
  }

  private reserveFreshCompletionReview(
    view: ActiveConversationSegmentProjection["view"],
    pageIndex: number,
    cardId: string | null,
    messageId: string,
    completionRender: ReturnType<NonNullable<ConversationSegmentStore["loadCompletionRenderState"]>>
  ): boolean {
    const actions = completionRender?.completionActions;
    if (!actions || actions.state !== "available" || actions.presentationKind !== "fresh-card" || !actions.choiceSpecification) return false;
    if (!this.store.preparePrimarySegmentCompletionActionSet || !this.presentation.completionReview) {
      throw new Error("Completion Review presentation is not connected");
    }
    const card = this.presentation.completionReview({
      actionSetId: actions.id,
      mentionOpenId: actions.mentionOpenId,
      ...(view.ownerKind === "worker" ? { subjectLabel: view.ownerLabel } : {}),
      choiceSpecification: actions.choiceSpecification
    });
    this.store.preparePrimarySegmentCompletionActionSet({ segmentId: view.segmentId, pageIndex, cardId, messageId, card });
    return true;
  }

  private loadLegacyTestProjection(segmentId: string) {
    const view = this.store.loadCardView(segmentId);
    if (!view) return null;
    const pages = this.store.listConversationSegmentPages(segmentId);
    const page = this.store.getActivePage(segmentId);
    return {
      view, page,
      pendingPage: pages.filter((candidate) => candidate.pendingReplyId || candidate.state === "creating" && !candidate.messageId).at(-1) ?? null,
      latestFrozenPage: pages.filter((candidate) => candidate.state === "frozen").at(-1) ?? null,
      cursorBase: 0,
      localStartCursor: page?.startCursor ?? null,
      startAnchor: null,
      itemPositions: view.timelineItems.map((item, index) => item.canonicalPosition ?? { laneSequence: index, itemOrdinal: 0 })
    };
  }

  private semanticBudget() {
    return { encodedBytes: this.payloadLimit, elementCount: 256, actionCount: 32, profileVersion: this.gatewayProfileVersion };
  }
}

function parityFingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function globalizeCursor(cursor: AnswerTimelineCursor | null, cursorBase: number): AnswerTimelineCursor | null {
  return cursor ? { ...cursor, itemIndex: cursor.itemIndex + cursorBase } : null;
}

function terminalCursor(projection: Pick<ActiveConversationSegmentProjection, "cursorBase" | "itemPositions">): AnswerTimelineCursor {
  return { itemIndex: projection.cursorBase + projection.itemPositions.length, markdownOffset: 0 };
}

function terminalSummary(state: ActiveConversationSegmentProjection["view"]["state"]): string {
  if (state === "closed") return "已并入后续输入";
  return state === "completed" ? "Completed" : state;
}

function anchorForLocalCursor(positions: readonly { laneSequence: number; itemOrdinal: number }[], cursor: AnswerTimelineCursor | null): ConversationSegmentCursorAnchor | null {
  if (positions.length === 0) return null;
  const index = Math.max(0, cursor?.itemIndex ?? 0);
  const position = positions[index] ?? positions.at(-1)!;
  return { position, inclusive: index < positions.length };
}
