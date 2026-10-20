import type { PromptJob } from "./prompt.js";
import type { RunCardView } from "./run-card-view.js";

export type PromptInputState = "queued" | "batched" | "cancelled";
export type NativeInputBatchState = "collecting" | "formed" | "cancelled";
export const NATIVE_INPUT_BATCH_WINDOW_MS = 2_000;

export interface NativeInputBacklog {
  unbatchedInputCount: number;
  pendingBatchCount: number;
}

export interface PromptInput {
  id: string;
  bindingId: string;
  bindingGeneration: number;
  ingressSource: "feishu";
  sourceMessageKey: string;
  larkMessageId: string;
  actorOpenId: string;
  body: string;
  rootMessageId: string;
  parentPromptId: string | null;
  state: PromptInputState;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeInputBatch {
  id: string;
  bindingId: string;
  bindingGeneration: number;
  state: NativeInputBatchState;
  windowOpenedAt: string;
  drainDueAt: string;
  combinedBody: string | null;
  executionPromptId: string | null;
  formedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeInputBatchMember {
  batchId: string;
  promptInputId: string;
  ordinal: number;
}

export interface AcceptImmediateNativeInputBatchInput {
  input: Omit<PromptInput, "state" | "batchId" | "createdAt" | "updatedAt">;
  batchId: string;
  combinedBody: string;
  occurredAt: string;
  view: RunCardView;
  answerCard: object;
  maxQueueDepth: number;
}

export interface NativeInputBatchAcceptanceResult {
  inserted: boolean;
  prompt: PromptJob;
  view: RunCardView;
  supersededPromptIds: readonly string[];
}

export interface AcceptCollectingNativeInputInput {
  input: Omit<PromptInput, "state" | "batchId" | "createdAt" | "updatedAt">;
  batchId: string;
  occurredAt: string;
  windowMs: number;
  maxQueueDepth: number;
}

export interface NativeInputCollectionResult {
  inserted: boolean;
  input: PromptInput;
  batch: NativeInputBatch;
  supersededPromptIds: readonly string[];
}

export interface NativeInputBatchProjection {
  view: RunCardView;
  rootMessageId: string;
  answerCard: object;
}

export interface FormDueNativeInputBatchInput {
  bindingId: string;
  occurredAt: string;
  nextBatchId: string;
  windowMs: number;
  createProjection(input: {
    batchId: string;
    binding: import("./binding.js").Binding;
    combinedBody: string;
    replyContext: string;
    titleSource: string;
    rootMessageId: string;
    memberCount: number;
    queuePosition: number;
  }): NativeInputBatchProjection;
}

export type NativeInputBatchFormationResult =
  | { outcome: "none" }
  | { outcome: "not_due"; batch: NativeInputBatch }
  | { outcome: "formed"; batch: NativeInputBatch; prompt: PromptJob; view: RunCardView; nextBatch: NativeInputBatch | null; supersededPromptIds: readonly string[] };

export function formatNativeInputBatch(bodies: readonly string[]): string {
  if (bodies.length === 0 || bodies.length > 3) throw new Error("Native Input Batch requires one to three messages");
  return bodies.map((body, index) => `[Feishu message ${index + 1}/${bodies.length}]\n${body}`).join("\n\n");
}

export function formatNativeInputReplyContext(bodies: readonly string[]): string {
  if (bodies.length === 0 || bodies.length > 3) throw new Error("Native Input Batch requires one to three messages");
  return bodies.join("\n\n");
}

export function parseNativeInputBatch(value: string): string[] | null {
  const firstHeader = /^\[Feishu message 1\/([1-3])\]\n/.exec(value);
  if (!firstHeader) return null;
  const count = Number(firstHeader[1]);
  const bodies: string[] = [];
  let bodyStart = firstHeader[0].length;
  for (let index = 1; index < count; index += 1) {
    const nextHeader = `\n\n[Feishu message ${index + 1}/${count}]\n`;
    const nextHeaderStart = value.indexOf(nextHeader, bodyStart);
    if (nextHeaderStart < 0) return null;
    bodies.push(value.slice(bodyStart, nextHeaderStart));
    bodyStart = nextHeaderStart + nextHeader.length;
  }
  bodies.push(value.slice(bodyStart));
  return formatNativeInputBatch(bodies) === value ? bodies : null;
}
