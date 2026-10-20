import { createHash } from "node:crypto";
import { planAndRenderTurnCard, TurnCardPayloadOverflowError, TurnCardPresentationBudgetError } from "../../cards/turn-card.js";
import type { ConversationPagePlan, ConversationPagePresentationBudget, ConversationPagePresentationMeasure } from "../../domain/conversation-segment.js";
import type { PresentationSnapshot } from "../../domain/delivery.js";
import type { ConversationSegmentCardView } from "../../domain/ports/conversation-segment.js";
import type { ConversationPagePresentationPolicy, ConversationSegmentCardPage, PresentationParityBounds, PresentationParityDescriptor, TurnCardRenderOptions } from "../../domain/ports/presentation.js";
import type { AnswerTimelineCursor } from "../../domain/types.js";
import type { GatewayView, GatewayViewNode } from "../contract/view.js";
import { cardKitToGatewayView } from "./cardkit-view.js";

type TurnCardPresentationContent = Readonly<{
  schemaVersion: 1;
  kind: "conversation-turn-card";
  pagePlan: ConversationPagePlan;
  view: ConversationSegmentCardView;
  page: ConversationSegmentCardPage;
  options: TurnCardRenderOptions;
  renderPayloadLimit: number;
}>;

type TurnCardPresentationSnapshot = PresentationSnapshot & TurnCardPresentationContent & Readonly<{
  presentationBudget: ConversationPagePresentationBudget;
  presentationMeasure: ConversationPagePresentationMeasure;
}>;

const TURN_CARD_POLICY_VERSION = 1;

/** Feishu-owned semantic policy: CardKit is interpreted only at this adapter boundary. */
export function createTurnCardPresentationPolicy(runtimeIdentity: TurnCardRenderOptions["runtimeIdentity"] = null): ConversationPagePresentationPolicy<TurnCardPresentationSnapshot, GatewayView> {
  return Object.freeze({
  plannerPolicyVersion: TURN_CARD_POLICY_VERSION,
  rendererPolicyVersion: TURN_CARD_POLICY_VERSION,
  plan(view: ConversationSegmentCardView, page: ConversationSegmentCardPage, options: TurnCardRenderOptions, budget: ConversationPagePresentationBudget) {
    assertPresentationBudget(budget);
    const frozenInput = freezeJson({
      view,
      page: { ...page, pageIndex: Math.max(0, page.pageIndex) },
      options: { ...options, runtimeIdentity },
    }) as { view: ConversationSegmentCardView; page: ConversationSegmentCardPage; options: TurnCardRenderOptions };
    let renderPayloadLimit = budget.encodedBytes;
    let planned = planAndRenderTurnCard(frozenInput.view, frozenInput.page, frozenInput.options, renderPayloadLimit);
    for (let attempt = 0; encodedBytes(planned.card) > budget.encodedBytes && attempt < 16; attempt += 1) {
      renderPayloadLimit = Math.max(1, renderPayloadLimit - (encodedBytes(planned.card) - budget.encodedBytes) - 64);
      planned = planAndRenderTurnCard(frozenInput.view, frozenInput.page, frozenInput.options, renderPayloadLimit);
    }
    const pagePlan: ConversationPagePlan = {
      policyVersion: TURN_CARD_POLICY_VERSION,
      budgetProfileVersion: budget.profileVersion,
      pageIndex: frozenInput.page.pageIndex,
      startCursor: cloneCursor(frozenInput.page.startCursor ?? frozenInput.page.cursor ?? null),
      endCursor: cloneCursor(planned.nextCursor),
      hasContinuation: planned.nextCursor !== null,
    };
    const measuredSnapshot = freezeJson({
      schemaVersion: 1,
      kind: "conversation-turn-card",
      pagePlan,
      view: frozenInput.view,
      page: frozenInput.page,
      options: frozenInput.options,
      renderPayloadLimit,
    }) as TurnCardPresentationContent;
    const measurement = measureTurnCardSnapshot(measuredSnapshot);
    if (measurement.encodedBytesUpperBound > budget.encodedBytes) {
      throw new TurnCardPayloadOverflowError(budget.encodedBytes, measurement.encodedBytesUpperBound);
    }
    if (measurement.elementCount > budget.elementCount) {
      throw new TurnCardPresentationBudgetError("elementCount", budget.elementCount, measurement.elementCount);
    }
    if (measurement.actionCount > budget.actionCount) {
      throw new TurnCardPresentationBudgetError("actionCount", budget.actionCount, measurement.actionCount);
    }
    const snapshot = freezeJson({
      ...measuredSnapshot,
      presentationBudget: budget,
      presentationMeasure: measurement,
    }) as TurnCardPresentationSnapshot;
    return Object.freeze({ pagePlan: snapshot.pagePlan, snapshot });
  },
  measure: measureTurnCardSnapshot,
  render: renderTurnCardSnapshot,
  compareLegacyPresentation(input: {
    legacyView: object;
    semanticSnapshot: TurnCardPresentationSnapshot;
    legacyDelivery: Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds">;
    semanticDelivery: Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds">;
  }) {
    const legacyView = gatewayViewFromTurnCard(input.legacyView);
    const semanticView = renderTurnCardSnapshot(input.semanticSnapshot);
    const legacyCounts = countGatewayNodes(legacyView.nodes);
    const semanticCommitted = input.semanticSnapshot.presentationMeasure;
    const semanticRecomputed = measureTurnCardSnapshot(input.semanticSnapshot);
    const legacyBounds = parityBounds(encodedBytes(input.legacyView), legacyCounts.elements, legacyCounts.actions);
    const legacy: PresentationParityDescriptor = {
      visibleStructureFingerprint: canonicalFingerprint(legacyView), ...input.legacyDelivery,
      committedBounds: legacyBounds, recomputedBounds: legacyBounds
    };
    const semantic: PresentationParityDescriptor = {
      visibleStructureFingerprint: canonicalFingerprint(semanticView), ...input.semanticDelivery,
      committedBounds: parityBounds(semanticCommitted.encodedBytesUpperBound, semanticCommitted.elementCount, semanticCommitted.actionCount),
      recomputedBounds: parityBounds(semanticRecomputed.encodedBytesUpperBound, semanticRecomputed.elementCount, semanticRecomputed.actionCount)
    };
    const mismatchFields = Object.keys(legacy) as Array<keyof PresentationParityDescriptor>;
    const mismatches = mismatchFields.filter((field) => JSON.stringify(legacy[field]) !== JSON.stringify(semantic[field]));
    return Object.freeze({ legacy: freezeJson(legacy), semantic: freezeJson(semantic), matched: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
  },
  });
}

export const turnCardPresentationPolicy = createTurnCardPresentationPolicy();

function renderTurnCardSnapshot(snapshot: TurnCardPresentationContent): GatewayView {
  const planned = planAndRenderTurnCard(snapshot.view, snapshot.page, snapshot.options, snapshot.renderPayloadLimit);
  if (!sameCursor(planned.nextCursor, snapshot.pagePlan.endCursor)) throw new Error("Turn Card snapshot no longer matches its canonical Page Plan");
  return gatewayViewFromTurnCard(planned.card);
}

function measureTurnCardSnapshot(snapshot: TurnCardPresentationContent): ConversationPagePresentationMeasure {
  const gatewayView = renderTurnCardSnapshot(snapshot);
  const counts = countGatewayNodes(gatewayView.nodes);
  const planned = planAndRenderTurnCard(snapshot.view, snapshot.page, snapshot.options, snapshot.renderPayloadLimit);
  return Object.freeze({ encodedBytesUpperBound: encodedBytes(planned.card), elementCount: counts.elements, actionCount: counts.actions });
}

function gatewayViewFromTurnCard(card: object): GatewayView {
  return freezeJson({ ...cardKitToGatewayView(card), widthMode: "fill" });
}

function countGatewayNodes(nodes: readonly GatewayViewNode[]): { elements: number; actions: number } {
  let elements = 0;
  let actions = 0;
  const visit = (node: GatewayViewNode): void => {
    elements += 1;
    if (node.kind === "button" || node.kind === "link" || node.kind === "select") actions += 1;
    if (node.kind === "columns") node.columns.forEach((column) => column.nodes.forEach(visit));
    if (node.kind === "panel" || node.kind === "form") node.nodes.forEach(visit);
  };
  nodes.forEach(visit);
  return { elements, actions };
}

function parityBounds(encodedBytesValue: number, elementCount: number, actionCount: number): PresentationParityBounds { return Object.freeze({ encodedBytes: encodedBytesValue, elementCount, actionCount }); }
function canonicalFingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function assertPresentationBudget(budget: ConversationPagePresentationBudget): void { for (const [name, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Turn Card presentation budget ${name} must be a positive integer`); }
function cloneCursor(cursor: AnswerTimelineCursor | null): AnswerTimelineCursor | null { return cursor ? { ...cursor } : null; }
function sameCursor(left: AnswerTimelineCursor | null, right: AnswerTimelineCursor | null): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function encodedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function freezeJson<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
  freeze(copy);
  return copy;
}
