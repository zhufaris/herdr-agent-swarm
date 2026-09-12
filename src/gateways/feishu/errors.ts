import { GatewayDeliveryError, type GatewayDeliveryIntent, type GatewayFailure } from "../contract/plugin.js";
import { safeLogError } from "../../runtime/safe-error.js";

const PERMANENT_CODES = new Set(["10002", "200740", "200750", "230028", "230031", "230099", "300309", "300317"]);
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);

export async function performFeishuDelivery<T>(intent: GatewayDeliveryIntent, providerOperation: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new GatewayDeliveryError(classifyFeishuFailure(error, intent, providerOperation), error); }
}

export function classifyFeishuFailure(error: unknown, intent: GatewayDeliveryIntent, providerOperation: string, currentTime = Date.now()): GatewayFailure {
  const safe = safeLogError(error);
  const httpStatus = safe.status ?? null;
  const providerCode = safe.larkCode === undefined ? null : String(safe.larkCode).slice(0, 128);
  const code = safe.code === undefined ? null : String(safe.code).toUpperCase();
  const timeout = error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
  let effectCertainty: GatewayFailure["effectCertainty"] = "uncertain";
  if (httpStatus !== null || providerCode !== null) effectCertainty = "rejected";
  else if (code !== null && PRE_CONNECT_CODES.has(code)) effectCertainty = "not-started";
  let failureClass: GatewayFailure["failureClass"] = "unknown";
  if (providerCode !== null && PERMANENT_CODES.has(providerCode)) failureClass = "permanent";
  else if (httpStatus === 429 || httpStatus !== null && httpStatus >= 500 || effectCertainty === "not-started") failureClass = "transient";
  else if (timeout || effectCertainty === "uncertain") failureClass = "unknown";
  const recoveryKind = providerCode === "300309" && providerOperation === "stream_card_content" && intent.purpose === "primary-answer"
    ? "closed_answer_stream" as const
    : providerCode === "230031" && (providerOperation === "update_card" || providerOperation === "update_cardkit") && intent.purpose === "primary-answer"
      ? "expired_view_target" as const
    : (providerCode === "230099" && (providerOperation === "update_card" || providerOperation === "update_cardkit") || providerCode === "300317" && providerOperation === "update_cardkit") && intent.purpose === "primary-main"
      ? "stale_main_card" as const : undefined;
  const retryAfterMs = httpStatus === 429 ? retryAfterDelayMs(error, currentTime) : undefined;
  return { failureClass, effectCertainty, httpStatus, providerCode, providerOperation, safeMessage: safe.message, ...(recoveryKind ? { recoveryKind } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function retryAfterDelayMs(error: unknown, currentTime: number): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : null;
  if (response?.status !== 429 || !isRecord(response.headers)) return undefined;
  const get = typeof response.headers.get === "function" ? response.headers.get as (name: string) => unknown : null;
  const header = get?.call(response.headers, "retry-after") ?? Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (typeof header !== "string" && typeof header !== "number") return undefined;
  const value = String(header).trim(); const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(3_600_000, Math.round(seconds * 1_000)) : undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(3_600_000, Math.max(0, timestamp - currentTime)) : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
