import { displayPaneToken } from "../domain/pane-display-identity.js";
import { parseNativeInputBatch } from "../domain/native-input-batch.js";
import type { RunCardView } from "../domain/run-card-view.js";
import { redactSecrets } from "../runtime/redact-secrets.js";

const ANSWER_HEADER_TEXT_LIMIT = 96;

export interface AnswerCardHeaderProjection {
  title: string;
  subtitle: string;
}

type AnswerHeaderSource = Pick<RunCardView, "spaceName" | "paneToken" | "requestText" | "replyContext" | "title">;

export function projectAnswerCardHeader(input: AnswerHeaderSource, pageNumber = 1): AnswerCardHeaderProjection {
  const pageSuffix = pageNumber > 1 ? ` · 第 ${pageNumber} 页` : "";
  return {
    title: truncate(`${input.spaceName} / ${displayPaneToken(input.paneToken)}${pageSuffix}`),
    subtitle: truncate(`Reply to 👤 ${replySummary(input)}`)
  };
}

function replySummary(input: Pick<AnswerHeaderSource, "requestText" | "replyContext" | "title">): string {
  const legacyBatch = input.replyContext == null ? parseNativeInputBatch(input.requestText) : null;
  const source = input.replyContext ?? legacyBatch?.join("\n\n") ?? input.requestText;
  const request = singleLine(redactSecrets(source));
  return request || singleLine(redactSecrets(input.title)) || "未命名任务";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length > ANSWER_HEADER_TEXT_LIMIT
    ? `${value.slice(0, ANSWER_HEADER_TEXT_LIMIT - 1)}…`
    : value;
}
