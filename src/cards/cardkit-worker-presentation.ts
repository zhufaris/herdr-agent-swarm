import type { WorkerPresentation } from "../domain/ports/presentation.js";
import { renderTurnControlResultCard } from "./turn-control-card.js";
import { renderWorkerTurnCard, workerTurnProgressContent } from "./worker-turn-card.js";
import { renderLarkMarkdownPage } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { workerTurnStreamContent } from "../domain/worker-turn-card-view.js";
import { renderWorkerHumanReviewNotification } from "./worker-human-review-notification.js";
import { planAnswerTimelinePage } from "./answer-timeline-page.js";

export const cardKitWorkerPresentation: WorkerPresentation = {
  workerTurn: renderWorkerTurnCard,
  workerHumanReviewNotification: renderWorkerHumanReviewNotification,
  workerTurnProgress: workerTurnProgressContent,
  turnControlResult: renderTurnControlResultCard,
  workerTurnPage: (view, pageStart, limit) => {
    const source = redactSecrets(workerTurnStreamContent(view));
    return { ...renderLarkMarkdownPage(source, pageStart, limit), sourceLength: source.length };
  },
  safeWorkerOutput: (value) => redactSecrets(value).slice(0, 64 * 1024),
  answerTimelinePage: planAnswerTimelinePage
};
