import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import { renderLarkMarkdownPage } from "../runtime/lark-markdown.js";
import type { FinalAnswerElement } from "./final-answer-content.js";
import { prepareAnswerTimelineItems, renderAnswerTimelineItem, renderAnswerToolGroup } from "./answer-timeline.js";
import { projectAnswerToolRenderGroupAt } from "./answer-tool-render-ports.js";

export interface AnswerTimelinePage {
  elements: FinalAnswerElement[];
  items: AnswerTimelineItem[];
  projectedItemIds: string[];
  nextCursor: AnswerTimelineCursor | null;
}
/**
 * Plans one bounded CardKit page. Tool panels are deliberately indivisible and
 * use their compact preview here: a verbose terminal result must never consume
 * a chain of Answer Cards and hide later human or agent messages.
 */
export function planAnswerTimelinePage(items: readonly AnswerTimelineItem[], cursor: AnswerTimelineCursor | null, payloadLimit: number, prefixItems: readonly AnswerTimelineItem[] = []): AnswerTimelinePage {
  const ordered = prepareAnswerTimelineItems(items);
  const elements: FinalAnswerElement[] = [];
  const pageItems: AnswerTimelineItem[] = [];
  const projectedItemIds: string[] = [];
  let itemIndex = Math.max(0, cursor?.itemIndex ?? 0);
  let markdownOffset = Math.max(0, cursor?.section === undefined || cursor.section === "message" ? cursor?.offset ?? cursor?.markdownOffset ?? 0 : 0);
  const orderedPrefix = prepareAnswerTimelineItems(prefixItems);
  for (let prefixIndex = 0; prefixIndex < orderedPrefix.length; prefixIndex += 1) {
    const item = orderedPrefix[prefixIndex]!;
    if (item.kind === "human_message") continue;
    const group = projectAnswerToolRenderGroupAt(orderedPrefix, prefixIndex);
    const available = Math.max(1, payloadLimit - JSON.stringify(elements).length);
    const rendered = group ? [renderAnswerToolGroup(group.model, available)] : renderAnswerTimelineItem(item, available, true);
    if (JSON.stringify([...elements, ...rendered]).length > payloadLimit) break;
    elements.push(...rendered);
    const consumed = orderedPrefix.slice(prefixIndex, prefixIndex + 1 + (group?.childCount ?? 0));
    pageItems.push(...consumed);
    projectedItemIds.push(...consumed.map(({ id }) => id));
    if (group) prefixIndex += group.childCount;
  }

  while (itemIndex < ordered.length) {
    const item = ordered[itemIndex]!;
    if (item.kind === "human_message") {
      if (pageItems.length > 0 || elements.length > 0) {
        return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: 0 } };
      }
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }
    if (item.kind === "agent_message" || item.kind === "final_answer") {
      const available = Math.max(1, payloadLimit - JSON.stringify(elements).length - 80);
      const rendered = renderLarkMarkdownPage(item.markdown, markdownOffset, available);
      if (rendered.page) {
        const candidate = { tag: "markdown", content: rendered.page };
        if (elements.length > 0 && JSON.stringify([...elements, candidate]).length > payloadLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset } };
        elements.push(candidate);
        pageItems.push({ ...item, markdown: rendered.page });
        if (!projectedItemIds.includes(item.id)) projectedItemIds.push(item.id);
      }
      if (rendered.nextPageStart !== null) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: rendered.nextPageStart } };
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }
    if (item.kind === "tool") {
      const group = projectAnswerToolRenderGroupAt(ordered, itemIndex);
      if (group) {
        const available = Math.max(1, payloadLimit - JSON.stringify(elements).length);
        const rendered = [renderAnswerToolGroup(group.model, available)];
        if (elements.length > 0 && JSON.stringify([...elements, ...rendered]).length > payloadLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: 0 } };
        elements.push(...rendered);
        const consumed = ordered.slice(itemIndex, itemIndex + 1 + group.childCount);
        pageItems.push(...consumed);
        projectedItemIds.push(...consumed.map(({ id }) => id));
        itemIndex += 1 + group.childCount;
        markdownOffset = 0;
        continue;
      }
      // `false` keeps the compact head/tail preview. This is presentation-only:
      // the complete tool record remains in the canonical timeline.
      const available = Math.max(1, payloadLimit - JSON.stringify(elements).length);
      const rendered = renderAnswerTimelineItem(item, available, false);
      if (elements.length > 0 && JSON.stringify([...elements, ...rendered]).length > payloadLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: 0 } };
      elements.push(...rendered);
      pageItems.push(item);
      projectedItemIds.push(item.id);
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }

    const available = Math.max(1, payloadLimit - JSON.stringify(elements).length);
    const rendered = renderAnswerTimelineItem(item, available, true);
    if (elements.length > 0 && JSON.stringify([...elements, ...rendered]).length > payloadLimit) return { elements, items: pageItems, projectedItemIds, nextCursor: { itemIndex, markdownOffset: 0 } };
    elements.push(...rendered);
    pageItems.push(item);
    projectedItemIds.push(item.id);
    itemIndex += 1;
  }
  return { elements, items: pageItems, projectedItemIds, nextCursor: null };
}
