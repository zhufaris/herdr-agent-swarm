import type { AnswerTimelineItem } from "./answer-timeline.js";

export function selectCompletionAssistantPreview(
  timelineItems: readonly AnswerTimelineItem[],
  fallbackMessages: readonly string[] = []
): string | undefined {
  const timelineMessage = [...timelineItems].reverse().find((item) =>
    (item.kind === "final_answer" || item.kind === "agent_message") && item.markdown.trim()
  );
  if (timelineMessage && "markdown" in timelineMessage) return timelineMessage.markdown;
  return [...fallbackMessages].reverse().find((message) => message.trim())?.trim();
}
