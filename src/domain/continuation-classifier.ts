export interface ContinuationInput { text: string; hasUnsupportedContent: boolean }
export type ContinuationRejection = "empty" | "too_long" | "slash_command" | "code_fence" | "unsupported_content" | "not_allowlisted";
export type ContinuationClassification = { eligible: true } | { eligible: false; reason: ContinuationRejection };

const EXACT = new Set(["继续", "继续处理", "按这个做", "可以", "确认"]);
const PREFIXES = ["补充：", "补充:", "另外注意：", "另外注意:", "再看下", "顺便检查"];

export function classifyContinuation(input: ContinuationInput): ContinuationClassification {
  const text = input.text.trim();
  if (!text) return { eligible: false, reason: "empty" };
  if (text.length > 100) return { eligible: false, reason: "too_long" };
  if (text.startsWith("/")) return { eligible: false, reason: "slash_command" };
  if (text.includes("```")) return { eligible: false, reason: "code_fence" };
  if (input.hasUnsupportedContent) return { eligible: false, reason: "unsupported_content" };
  return EXACT.has(text) || PREFIXES.some((prefix) => text.startsWith(prefix))
    ? { eligible: true }
    : { eligible: false, reason: "not_allowlisted" };
}
