import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import { renderLarkMarkdownPage } from "../runtime/lark-markdown.js";
import type { FinalAnswerElement } from "./final-answer-content.js";
import { renderAnswerTimelineItem } from "./answer-timeline.js";

export interface AnswerTimelinePage {
  elements: FinalAnswerElement[];
  items: AnswerTimelineItem[];
  projectedItemIds: string[];
  nextCursor: AnswerTimelineCursor | null;
}

export const ANSWER_TIMELINE_PAGE_LIMIT = 9_000;

/** Plans one bounded CardKit page while treating Tool and status panels as indivisible items. */
export function planAnswerTimelinePage(items: readonly AnswerTimelineItem[], cursor: AnswerTimelineCursor | null, payloadLimit: number, prefixItems: readonly AnswerTimelineItem[] = []): AnswerTimelinePage {
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const contentLimit = Math.min(payloadLimit, ANSWER_TIMELINE_PAGE_LIMIT);
  const elements: FinalAnswerElement[] = [];
  const pageItems: AnswerTimelineItem[] = [];
  const projectedItemIds: string[] = [];
  let itemIndex = Math.max(0, cursor?.itemIndex ?? 0);
  let markdownOffset = Math.max(0, cursor?.markdownOffset ?? 0);
  for (const item of prefixItems) {
    if (item.kind === "status") { projectedItemIds.push(item.id); continue; }
    const rendered = renderAnswerTimelineItem(item, Math.max(1, contentLimit - JSON.stringify(elements).length));
    if (JSON.stringify([...elements, ...rendered]).length > contentLimit) break;
    elements.push(...rendered);
    pageItems.push(item);
    projectedItemIds.push(item.id);
  }

  while (itemIndex < ordered.length) {
    const item = ordered[itemIndex]!;
    if (item.kind === "status") {
      projectedItemIds.push(item.id);
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }
    if (item.kind === "agent_message" || item.kind === "final_answer") {
      const boundary = item.kind === "final_answer" && markdownOffset === 0 ? "✅ **最终回答**\n\n" : "";
      const available = Math.max(1, contentLimit - JSON.stringify(elements).length - 80 - boundary.length);
      const rendered = renderLarkMarkdownPage(item.markdown, markdownOffset, available);
      if (rendered.page) {
        const candidate = { tag: "markdown", content: `${boundary}${rendered.page}` };
        if (elements.length > 0 && JSON.stringify([...elements, candidate]).length > contentLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset } };
        elements.push(candidate);
        pageItems.push({ ...item, markdown: rendered.page });
        if (!projectedItemIds.includes(item.id)) projectedItemIds.push(item.id);
      }
      if (rendered.nextPageStart !== null) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: rendered.nextPageStart } };
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }

    const available = Math.max(1, contentLimit - JSON.stringify(elements).length);
    const rendered = renderAnswerTimelineItem(item, available);
    if (elements.length > 0 && JSON.stringify([...elements, ...rendered]).length > contentLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: 0 } };
    elements.push(...rendered);
    pageItems.push(item);
    projectedItemIds.push(item.id);
    itemIndex += 1;
  }
  return { elements, items: pageItems, projectedItemIds, nextCursor: null };
}
