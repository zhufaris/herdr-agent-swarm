import type { OutboxStore } from "../domain/ports/outbox.js";
import { answerElementId } from "../domain/run-card-view.js";
import { workerTurnElementId } from "../domain/worker-turn-card-view.js";

export class PermanentDeliveryError extends Error {}

export function assertWorkerMainCreateTarget(store: Pick<OutboxStore, "loadWorkerMainView">, workerId: string, workerSessionGeneration: number, rootMessageId: string): void {
  const view = store.loadWorkerMainView(workerId, workerSessionGeneration);
  if (!view || view.messageId !== null || view.cardId !== null || view.parentBindingId.length === 0 || rootMessageId.length === 0) throw new PermanentDeliveryError(`Worker Main create target mismatch for ${workerId}:${workerSessionGeneration}`);
}

export function assertWorkerMainMessageTarget(store: Pick<OutboxStore, "loadWorkerMainView">, workerId: string, workerSessionGeneration: number, messageId: string): void {
  const view = store.loadWorkerMainView(workerId, workerSessionGeneration);
  if (!view || view.messageId !== messageId) throw new PermanentDeliveryError(`Worker Main message target mismatch for ${workerId}:${workerSessionGeneration}`);
}

export function assertAnswerCardCreateTarget(
  store: Pick<OutboxStore, "getBinding" | "isActiveBindingThreadAlias" | "loadRunCard">, bindingId: string | null, promptId: string | null, rootMessageId: string,
  card: object, stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" }
): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer card create target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const binding = store.getBinding(bindingId);
  const validRoot = binding?.rootMessageId === rootMessageId || store.isActiveBindingThreadAlias(bindingId, rootMessageId);
  if (!view || view.bindingId !== bindingId || !validRoot) throw new PermanentDeliveryError(`Answer card create target mismatch for prompt ${promptId}`);
  if (!stream) {
    if (view.answerMessageId || view.answerCardId || view.answerPageIndex !== 0) throw new PermanentDeliveryError(`Initial answer card create is stale for prompt ${promptId}`);
    return;
  }
  if (stream.pageIndex === 0) {
    const expectedElementId = answerElementId(promptId, 0);
    const cardElementIds = collectElementIds(card);
    if (view.answerMessageId || view.answerCardId || view.answerPageIndex !== 0 || stream.pageStart !== 0 || stream.elementId !== expectedElementId || cardElementIds.length === 0 || cardElementIds.some((id) => id !== expectedElementId)) throw new PermanentDeliveryError(`Initial answer card create is stale for prompt ${promptId}`);
    return;
  }
  const expectedPageStart = stream.deliveryMode === "static" ? stream.pageStart === view.answerPageStart : stream.pageStart > view.answerPageStart;
  if (!view.answerCardId || stream.pageIndex !== view.answerPageIndex + 1 || !expectedPageStart || !stream.elementId) throw new PermanentDeliveryError(`Answer continuation target mismatch for prompt ${promptId}`);
  const expectedElementId = answerElementId(promptId, stream.pageIndex);
  const cardElementIds = collectElementIds(card);
  if (stream.elementId !== expectedElementId || cardElementIds.length === 0 || cardElementIds.some((id) => id !== stream.elementId)) throw new PermanentDeliveryError(`Answer continuation element mismatch for prompt ${promptId}`);
}

export function assertAnswerCardTarget(store: Pick<OutboxStore, "getActiveAnswerPage" | "loadRunCard">, bindingId: string | null, promptId: string | null, cardId: string): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer stream target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const page = store.getActiveAnswerPage(promptId);
  if (!view || view.bindingId !== bindingId || (page?.cardId ?? view.answerCardId) !== cardId) throw new PermanentDeliveryError(`Answer stream card target mismatch for prompt ${promptId}`);
}

export function assertAnswerStreamTarget(store: Pick<OutboxStore, "getActiveAnswerPage" | "loadRunCard">, bindingId: string | null, promptId: string | null, cardId: string, elementId: string): void {
  assertAnswerCardTarget(store, bindingId, promptId, cardId);
  const view = store.loadRunCard(promptId!);
  const page = store.getActiveAnswerPage(promptId!);
  if (!view || (page?.elementId ?? view.answerElementId) !== elementId) throw new PermanentDeliveryError(`Answer stream element target mismatch for prompt ${promptId}`);
}

export function assertAnswerMessageTarget(store: Pick<OutboxStore, "loadRunCard">, bindingId: string | null, promptId: string | null, messageId: string): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer card target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  if (!view || view.bindingId !== bindingId || view.answerMessageId !== messageId) throw new PermanentDeliveryError(`Answer card message target mismatch for prompt ${promptId}`);
}

export function assertAnswerRichTextCreateTarget(
  store: Pick<OutboxStore, "getActiveAnswerPage" | "getBinding" | "isActiveBindingThreadAlias" | "loadRunCard">,
  bindingId: string | null, promptId: string | null, rootMessageId: string,
  page: { pageIndex: number; pageStart: number; elementId: string }
): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer rich-text create target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const binding = store.getBinding(bindingId);
  const validRoot = binding?.rootMessageId === rootMessageId || store.isActiveBindingThreadAlias(bindingId, rootMessageId);
  if (!view || view.bindingId !== bindingId || !validRoot || page.elementId !== answerElementId(promptId, page.pageIndex)) throw new PermanentDeliveryError(`Answer rich-text create target mismatch for prompt ${promptId}`);
  if (page.pageIndex === 0) {
    if (view.answerMessageId || view.answerPageIndex !== 0 || page.pageStart !== 0) throw new PermanentDeliveryError(`Initial answer rich-text create is stale for prompt ${promptId}`);
    return;
  }
  if (view.answerPageIndex !== page.pageIndex - 1 || view.answerMessageId === null || page.pageStart <= view.answerPageStart) throw new PermanentDeliveryError(`Answer rich-text continuation target mismatch for prompt ${promptId}`);
}

export function assertAnswerRichTextUpdateTarget(
  store: Pick<OutboxStore, "getActiveAnswerPage" | "getBinding" | "loadRunCard">,
  bindingId: string | null, promptId: string | null, messageId: string,
  page: { pageIndex: number; pageStart: number; elementId: string }
): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer rich-text update target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const binding = store.getBinding(bindingId);
  const active = store.getActiveAnswerPage(promptId);
  if (!view || !binding || binding.generation !== view.bindingGeneration || view.bindingId !== bindingId || !active || active.deliveryMode !== "rich_post" || active.pageIndex !== page.pageIndex || active.sourceStart !== page.pageStart || active.elementId !== page.elementId || active.messageId !== messageId) throw new PermanentDeliveryError(`Answer rich-text update target mismatch for prompt ${promptId}`);
}

export function assertWorkerCardCreateTarget(
  store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, rootMessageId: string,
  card: object, stream?: { pageIndex: number; pageStart: number; elementId: string }
): void {
  const view = store.loadWorkerTurnCard(turnId);
  if (!view || view.rootMessageId !== rootMessageId || !stream) throw new PermanentDeliveryError(`Worker card create target mismatch for turn ${turnId}`);
  const pages = store.listWorkerTurnCardPages(turnId);
  const page = pages.find(({ pageIndex }) => pageIndex === stream.pageIndex);
  if (!page || page.pageStart !== stream.pageStart || page.elementId !== stream.elementId || page.messageId || page.cardId) throw new PermanentDeliveryError(`Worker card page target mismatch for turn ${turnId}`);
  const expectedElementId = workerTurnElementId(turnId, stream.pageIndex);
  const cardElementIds = collectElementIds(card);
  if (stream.elementId !== expectedElementId || cardElementIds.length === 0 || cardElementIds.some((id) => id !== expectedElementId)) throw new PermanentDeliveryError(`Worker card element mismatch for turn ${turnId}`);
}

export function assertWorkerCardTarget(store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, cardId: string, elementId?: string): void {
  const view = store.loadWorkerTurnCard(turnId);
  const page = store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === view?.pageIndex);
  if (!view || !page || page.cardId !== cardId || (elementId !== undefined && page.elementId !== elementId)) throw new PermanentDeliveryError(`Worker card target mismatch for turn ${turnId}`);
}

export function assertWorkerMessageTarget(store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, messageId: string): void {
  const view = store.loadWorkerTurnCard(turnId);
  const page = store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === view?.pageIndex);
  if (!view || (page?.messageId ?? view.messageId) !== messageId) throw new PermanentDeliveryError(`Worker card message target mismatch for turn ${turnId}`);
}

export function assertWorkerRichTextCreateTarget(
  store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">,
  turnId: string, rootMessageId: string, page: { pageIndex: number; pageStart: number; elementId: string }
): void {
  const view = store.loadWorkerTurnCard(turnId);
  const stored = store.listWorkerTurnCardPages(turnId).find(({ pageIndex }) => pageIndex === page.pageIndex);
  if (!view || view.rootMessageId !== rootMessageId || !stored || stored.pageStart !== page.pageStart || stored.elementId !== page.elementId || stored.messageId || stored.cardId) throw new PermanentDeliveryError(`Worker rich-text create target mismatch for turn ${turnId}`);
  if (page.elementId !== workerTurnElementId(turnId, page.pageIndex)) throw new PermanentDeliveryError(`Worker rich-text page identity mismatch for turn ${turnId}`);
}

export function assertWorkerRichTextUpdateTarget(
  store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">,
  turnId: string, messageId: string, page: { pageIndex: number; pageStart: number; elementId: string }
): void {
  const view = store.loadWorkerTurnCard(turnId);
  const stored = store.listWorkerTurnCardPages(turnId).find(({ pageIndex }) => pageIndex === page.pageIndex);
  if (!view || view.instanceGeneration < 1 || !stored || stored.deliveryMode !== "rich_post" || stored.state !== "active" || stored.messageId !== messageId || stored.pageStart !== page.pageStart || stored.elementId !== page.elementId || view.pageIndex !== page.pageIndex) throw new PermanentDeliveryError(`Worker rich-text update target mismatch for turn ${turnId}`);
}

function collectElementIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectElementIds);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => (key === "element_id" || key === "slot") && typeof item === "string" ? [item] : collectElementIds(item));
}
