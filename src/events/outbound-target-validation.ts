import type { OutboxStore } from "../domain/ports/outbox.js";
import { answerElementId } from "../domain/run-card-view.js";
import { workerTurnElementId, workerTurnProgressElementId } from "../domain/worker-turn-card-view.js";

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
  store: Pick<OutboxStore, "getBinding" | "loadRunCard">, bindingId: string | null, promptId: string | null, rootMessageId: string,
  card: object, stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" }
): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer card create target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const binding = store.getBinding(bindingId);
  if (!view || view.bindingId !== bindingId || binding?.rootMessageId !== rootMessageId) throw new PermanentDeliveryError(`Answer card create target mismatch for prompt ${promptId}`);
  if (!stream) {
    if (view.answerMessageId || view.answerCardId || view.answerPageIndex !== 0) throw new PermanentDeliveryError(`Initial answer card create is stale for prompt ${promptId}`);
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
  const expectedProgressElementId = workerTurnProgressElementId(turnId, stream.pageIndex);
  const allowedElementIds = new Set([expectedProgressElementId, expectedElementId]);
  const outputElementIsValid = view.phase === "completed" ? cardElementIds.includes(expectedElementId) : !cardElementIds.includes(expectedElementId);
  if (stream.elementId !== expectedElementId || !cardElementIds.includes(expectedProgressElementId) || !outputElementIsValid || cardElementIds.some((id) => !allowedElementIds.has(id))) throw new PermanentDeliveryError(`Worker card element mismatch for turn ${turnId}`);
}

export function assertWorkerCardTarget(store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, cardId: string, elementId?: string): void {
  const view = store.loadWorkerTurnCard(turnId);
  const page = store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === view?.pageIndex);
  if (!view || !page || page.cardId !== cardId || (elementId !== undefined && page.elementId !== elementId)) throw new PermanentDeliveryError(`Worker card target mismatch for turn ${turnId}`);
}

export function assertWorkerProgressTarget(store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, cardId: string, elementId: string, pageIndex: number): void {
  const page = store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === pageIndex);
  if (!page || page.cardId !== cardId || elementId !== workerTurnProgressElementId(turnId, pageIndex)) throw new PermanentDeliveryError(`Worker progress target mismatch for turn ${turnId}`);
}

export function assertWorkerMessageTarget(store: Pick<OutboxStore, "loadWorkerTurnCard" | "listWorkerTurnCardPages">, turnId: string, messageId: string): void {
  const view = store.loadWorkerTurnCard(turnId);
  const page = store.listWorkerTurnCardPages(turnId).find((candidate) => candidate.pageIndex === view?.pageIndex);
  if (!view || (page?.messageId ?? view.messageId) !== messageId) throw new PermanentDeliveryError(`Worker card message target mismatch for turn ${turnId}`);
}

function collectElementIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectElementIds);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => key === "element_id" && typeof item === "string" ? [item] : collectElementIds(item));
}
