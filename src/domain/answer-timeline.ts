export type AnswerTimelineToolCategory = "read" | "search" | "edit" | "command" | "test" | "step";
export type AnswerTimelineToolState = "running" | "succeeded" | "failed";

interface AnswerTimelineItemBase { id: string; sequence: number }

export type AnswerTimelineItem =
  | AnswerTimelineItemBase & { kind: "agent_message"; markdown: string }
  | AnswerTimelineItemBase & { kind: "tool"; category: AnswerTimelineToolCategory; label: string; command?: string; resultPreview?: string; state: AnswerTimelineToolState }
  | AnswerTimelineItemBase & { kind: "status"; label: string; state: "running" | "blocked" | "failed" }
  | AnswerTimelineItemBase & { kind: "final_answer"; markdown: string };

/** A stable-ID upsert emitted in canonical transcript order. */
export type AnswerTimelineDelta = AnswerTimelineItem;

export function applyAnswerTimelineDeltas(current: readonly AnswerTimelineItem[], deltas: readonly AnswerTimelineDelta[]): AnswerTimelineItem[] {
  if (deltas.length === 0) return [...current];
  const items = new Map(current.map((item) => [item.id, item]));
  for (const delta of deltas) items.set(delta.id, delta);
  return [...items.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function terminalizeAnswerTimelineTools(current: readonly AnswerTimelineItem[], state: "failed" | "succeeded" = "failed"): AnswerTimelineItem[] {
  let changed = false;
  const items = current.map((item) => {
    if (item.kind !== "tool" || item.state !== "running") return item;
    changed = true;
    return { ...item, state };
  });
  return changed ? items : [...current];
}

export function sameAnswerTimeline(left: readonly AnswerTimelineItem[], right: readonly AnswerTimelineItem[]): boolean {
  return left.length === right.length && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}
