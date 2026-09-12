import type { DeliveryEffectCertainty, DeliveryFailureMetadata } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PermanentDeliveryError } from "./outbound-target-validation.js";

export interface ClassifiedDeliveryFailure extends Omit<DeliveryFailureMetadata, "effectCertainty"> { effectCertainty: DeliveryEffectCertainty; message: string; retryDelayMs?: number }

// CardKit documents these as invalid parameters, a missing entity, or an
// expired entity. Repeating the same durable intent cannot repair the target.
const PERMANENT_LARK_CODES = new Set(["10002", "200740", "200750"]);
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);
const CARDKIT_RECOVERY_KINDS = new Map([
  ["300309", "closed_answer_stream"],
  ["300317", "stale_main_card"]
] as const);

export function classifyDeliveryError(error: unknown, currentTime = Date.now()): ClassifiedDeliveryFailure {
  const safe = safeLogError(error);
  const httpStatus = safe.status ?? null;
  const larkErrorCode = safe.larkCode === undefined ? null : String(safe.larkCode).slice(0, 128);
  const code = safe.code === undefined ? null : String(safe.code).toUpperCase();
  const recoveryKind = larkErrorCode === "300309" || larkErrorCode === "300317" ? CARDKIT_RECOVERY_KINDS.get(larkErrorCode) : undefined;
  const timeout = error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
  let failureClass: DeliveryFailureMetadata["failureClass"] = "unknown";
  let effectCertainty: DeliveryEffectCertainty = "uncertain";
  if (error instanceof PermanentDeliveryError || httpStatus !== null || larkErrorCode !== null) effectCertainty = "rejected";
  else if (code !== null && PRE_CONNECT_CODES.has(code)) effectCertainty = "not-started";
  if (error instanceof PermanentDeliveryError || recoveryKind !== undefined || larkErrorCode !== null && PERMANENT_LARK_CODES.has(larkErrorCode)) failureClass = "permanent";
  else if (httpStatus === 429 || httpStatus !== null && httpStatus >= 500 || effectCertainty === "not-started") failureClass = "transient";
  else if (timeout || effectCertainty === "uncertain") failureClass = "unknown";
  const retryDelayMs = httpStatus === 429 ? retryAfterDelayMs(error, currentTime) : undefined;
  return { failureClass, effectCertainty, httpStatus, larkErrorCode, message: safe.message, ...(recoveryKind === undefined ? {} : { recoveryKind }), ...(retryDelayMs === undefined ? {} : { retryDelayMs }) };
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
