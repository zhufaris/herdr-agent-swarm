const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface SafeLogError {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  larkCode?: string | number;
  requestId?: string;
}

/** Converts arbitrary thrown values into a bounded, whitelist-only log shape. */
export function safeLogError(error: unknown): SafeLogError {
  const value = asRecord(error);
  const response = asRecord(value?.response);
  const responseData = asRecord(response?.data);
  const responseError = asRecord(responseData?.error);
  const result: SafeLogError = {
    name: error instanceof Error ? error.name : stringValue(value?.name)?.slice(0, 128) ?? (value ? "Error" : typeof error),
    message: sanitizeMessage(error instanceof Error ? error.message : stringValue(value?.message) ?? String(error))
  };

  const code = scalar(value?.code);
  const status = finiteNumber(value?.status) ?? finiteNumber(response?.status);
  const larkCode = scalar(value?.larkCode) ?? scalar(responseData?.code);
  const requestId = stringValue(value?.requestId) ?? stringValue(responseError?.log_id) ?? stringValue(responseData?.request_id);
  if (code !== undefined) result.code = code;
  if (status !== undefined) result.status = status;
  if (larkCode !== undefined) result.larkCode = larkCode;
  if (requestId !== undefined) result.requestId = requestId.slice(0, 128);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function scalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" ? value.slice(0, 128) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|token|app_secret|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
