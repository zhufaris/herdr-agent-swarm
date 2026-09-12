import type { DeliveryEffectCertainty, DeliveryFailureMetadata, DeliveryOperationContext } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { DeliveryOperationError } from "./delivery-operation-error.js";
import { PermanentDeliveryError } from "./outbound-target-validation.js";

export interface ClassifiedDeliveryFailure extends Omit<DeliveryFailureMetadata, "effectCertainty"> { effectCertainty: DeliveryEffectCertainty; message: string; operationContext?: DeliveryOperationContext; retryDelayMs?: number }

// Definite business rejections in this set cannot be repaired by repeating the
// same durable revision. Matching operation contexts may authorize replacement.
const PERMANENT_LARK_CODES = new Set(["10002", "200740", "200750", "230028", "230099", "300309", "300317"]);
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);

export function classifyDeliveryError(error: unknown, context?: DeliveryOperationContext, currentTime = Date.now()): ClassifiedDeliveryFailure {
  const operationContext = context ?? (error instanceof DeliveryOperationError ? error.context : undefined);
  const cause = error instanceof DeliveryOperationError ? error.cause : error;
  const safe = safeLogError(cause);
  const httpStatus = safe.status ?? null;
  const larkErrorCode = safe.larkCode === undefined ? null : String(safe.larkCode).slice(0, 128);
  const code = safe.code === undefined ? null : String(safe.code).toUpperCase();
  const recoveryKind = semanticRecoveryKind(larkErrorCode, operationContext);
  const timeout = cause instanceof Error && (cause.name === "AbortError" || /timeout|timed out/i.test(cause.message));
  let failureClass: DeliveryFailureMetadata["failureClass"] = "unknown";
  let effectCertainty: DeliveryEffectCertainty = "uncertain";
  if (cause instanceof PermanentDeliveryError || httpStatus !== null || larkErrorCode !== null) effectCertainty = "rejected";
  else if (code !== null && PRE_CONNECT_CODES.has(code)) effectCertainty = "not-started";
  if (cause instanceof PermanentDeliveryError || larkErrorCode !== null && PERMANENT_LARK_CODES.has(larkErrorCode)) failureClass = "permanent";
  else if (httpStatus === 429 || httpStatus !== null && httpStatus >= 500 || effectCertainty === "not-started") failureClass = "transient";
  else if (timeout || effectCertainty === "uncertain") failureClass = "unknown";
  const retryDelayMs = httpStatus === 429 ? retryAfterDelayMs(cause, currentTime) : undefined;
  return { failureClass, effectCertainty, httpStatus, larkErrorCode, message: safe.message, ...(operationContext === undefined ? {} : { operationContext }), ...(recoveryKind === undefined ? {} : { recoveryKind }), ...(retryDelayMs === undefined ? {} : { retryDelayMs }) };
}

function semanticRecoveryKind(code: string | null, context?: DeliveryOperationContext): DeliveryFailureMetadata["recoveryKind"] {
  if (!context) return undefined;
  if (context.target === "primary_main" && (
    code === "230099" && (context.operation === "update_card" || context.operation === "update_cardkit")
    || code === "300317" && context.operation === "update_cardkit"
  )) return "stale_main_card";
  if (code === "300309" && context.target === "primary_answer" && context.operation === "stream_card_content") return "closed_answer_stream";
  return undefined;
}

function retryAfterDelayMs(error: unknown, currentTime: number): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : null;
  if (response?.status !== 429 || !isRecord(response.headers)) return undefined;
  const get = typeof response.headers.get === "function" ? response.headers.get as (name: string) => unknown : null;
  const header = get?.call(response.headers, "retry-after")
    ?? Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (typeof header !== "string" && typeof header !== "number") return undefined;
  const value = String(header).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - currentTime) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
