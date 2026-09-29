import type { AnswerTimelineItem } from "./answer-timeline.js";
import type { AnswerTimelinePageCheckpoint } from "./delivery.js";
import { answerTimelineItemFingerprint } from "./answer-timeline-late-results.js";

/** Selects the narrow CardKit update only when the current trailing Agent message is the sole timeline change. */
export function isPureAgentMarkdownUpdate(checkpoint: AnswerTimelinePageCheckpoint, items: readonly AnswerTimelineItem[]): boolean {
  if (checkpoint.pending || items.length === 0 || checkpoint.deliveredItems.length !== items.length) return false;
  const tail = items.at(-1);
  if (!tail || tail.kind !== "agent_message") return false;
  for (let index = 0; index < items.length - 1; index += 1) {
    const delivered = checkpoint.deliveredItems[index];
    const current = items[index]!;
    if (!delivered || delivered.id !== current.id || delivered.fingerprint !== answerTimelineItemFingerprint(current)) return false;
  }
  const deliveredTail = checkpoint.deliveredItems.at(-1);
  return deliveredTail?.id === tail.id && deliveredTail.fingerprint !== answerTimelineItemFingerprint(tail);
}
