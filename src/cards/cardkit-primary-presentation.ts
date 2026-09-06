import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { renderDisconnectedTopicCard, renderMessageRejectedCard, renderProjectEntryCard, renderRequestAnswerCard } from "./run-card.js";

export const cardKitPrimaryPresentation: PrimaryPresentation = {
  mainCard: renderProjectEntryCard,
  answerCard: renderRequestAnswerCard,
  disconnectedTopic: renderDisconnectedTopicCard,
  requestRejected: renderMessageRejectedCard
};
