import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { answerStreamContent, renderAnswerStreamPage, renderFinalAnswerPage } from "../runtime/answer-stream.js";
import { renderDisconnectedTopicCard, renderFinalAnswerCard, renderMessageRejectedCard, renderProjectEntryCard, renderRequestAnswerCard } from "./run-card.js";

export interface CardKitPresentationLimits { payloadLimitChars: number; answerStreamLimitChars: number; }

export function createCardKitPrimaryPresentation(limits: CardKitPresentationLimits): PrimaryPresentation {
  return {
    mainCard: renderProjectEntryCard,
    answerCard: renderRequestAnswerCard,
    disconnectedTopic: renderDisconnectedTopicCard,
    requestRejected: renderMessageRejectedCard,
    finalAnswer: (view, options) => renderFinalAnswerCard(view, options, limits.payloadLimitChars),
    answerStreamContent,
    answerStreamPage: (content, pageStart, limit = limits.answerStreamLimitChars) => renderAnswerStreamPage(content, pageStart, Math.min(limit, limits.answerStreamLimitChars)),
    finalAnswerPage: (content, pageStart, pageEnd = content.length) => renderFinalAnswerPage(content, pageStart, Math.min(pageEnd, pageStart + limits.answerStreamLimitChars))
  };
}

export const cardKitPrimaryPresentation = createCardKitPrimaryPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
