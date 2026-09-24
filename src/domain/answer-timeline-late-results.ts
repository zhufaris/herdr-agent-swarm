import { createHash } from "node:crypto";
import type { AnswerTimelineFrozenItem } from "./delivery.js";
import type { AnswerTimelineItem } from "./answer-timeline.js";

/** Adds render-only completion items when a frozen Tool panel can no longer be patched. */
export function lateAnswerTimelineResults(items: readonly AnswerTimelineItem[], frozen: readonly AnswerTimelineFrozenItem[], activePageIndex: number): AnswerTimelineItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const frozenIds = new Set(frozen.map(({ id }) => id));
  return frozen.flatMap((previous) => {
    const item = byId.get(previous.id);
    const lateId = `late:${previous.id}`;
    if (!item || item.kind !== "tool" || item.state === "running" || fingerprint(item) === previous.fingerprint || frozenIds.has(lateId)) return [];
    return [{ ...item, id: lateId, sequence: -1, label: `${item.label}（更新自第 ${previous.pageIndex + 1} 页）` }];
  });
}

function fingerprint(item: AnswerTimelineItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}
