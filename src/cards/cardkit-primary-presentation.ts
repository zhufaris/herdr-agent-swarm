import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { answerStreamContent, renderAnswerStreamPage, renderFinalAnswerPage } from "../runtime/answer-stream.js";
import { renderDisconnectedTopicCard, renderFinalAnswerCard, renderMessageRejectedCard, renderProjectEntryCard, renderRequestAnswerCard } from "./run-card.js";

export const cardKitPrimaryPresentation: PrimaryPresentation = {
  mainCard: renderProjectEntryCard,
  answerCard: renderRequestAnswerCard,
  disconnectedTopic: renderDisconnectedTopicCard,
  requestRejected: renderMessageRejectedCard,
  finalAnswer: renderFinalAnswerCard,
  answerStreamContent,
  answerStreamPage: renderAnswerStreamPage,
  finalAnswerPage: renderFinalAnswerPage
};
