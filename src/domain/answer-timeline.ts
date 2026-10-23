export type AnswerTimelineToolCategory = "read" | "search" | "edit" | "command" | "test" | "skill" | "tool" | "step";
export type AnswerTimelineToolState = "running" | "succeeded" | "failed";
export interface AnswerTimelineToolResultSummary { outcome: "success" | "failure" | "timeout"; text: string }

export interface AnswerTimelineCanonicalPosition { laneSequence: number; itemOrdinal: number }
interface AnswerTimelineItemBase { id: string; sequence: number; canonicalPosition?: AnswerTimelineCanonicalPosition }

export type AnswerTimelineItem =
  | AnswerTimelineItemBase & { kind: "human_message"; markdown: string }
  | AnswerTimelineItemBase & { kind: "agent_message"; markdown: string }
  | AnswerTimelineItemBase & { kind: "thinking"; label: string; markdown?: string }
  | AnswerTimelineItemBase & { kind: "tool"; category: AnswerTimelineToolCategory; label: string; action?: string; target?: string; context?: string; command?: string; result?: string; resultPreview?: string; resultSummary?: AnswerTimelineToolResultSummary; diff?: string; parentToolId?: string; continuation?: boolean; groupChildCount?: number; nested?: boolean; state: AnswerTimelineToolState }
  | AnswerTimelineItemBase & { kind: "status"; label: string; detail?: string; detailTruncated?: boolean; state: "running" | "completed" | "blocked" | "failed" | "interrupted" | "cancelled" | "warning" }
  | AnswerTimelineItemBase & { kind: "final_answer"; markdown: string };

/** A stable-ID upsert emitted in canonical transcript order. */
export type AnswerTimelineDelta = AnswerTimelineItem;

export function mergeAnswerTimelineItem(prior: AnswerTimelineItem | undefined, next: AnswerTimelineItem): AnswerTimelineItem {
  if (next.kind === "status" && prior?.kind === "status" && next.detail === undefined && prior.detail !== undefined) {
    return { ...next, detail: prior.detail, ...(prior.detailTruncated === undefined ? {} : { detailTruncated: prior.detailTruncated }) };
  }
  return next;
}

export function applyAnswerTimelineDeltas(current: readonly AnswerTimelineItem[], deltas: readonly AnswerTimelineDelta[]): AnswerTimelineItem[] {
  if (deltas.length === 0) return [...current];
  const items = new Map(current.map((item) => [item.id, item]));
  for (const delta of deltas) {
    items.set(delta.id, mergeAnswerTimelineItem(items.get(delta.id), delta));
  }
  const result = [...items.values()];
  assertCanonicalTimelineOrder(result);
  return result;
}

export function assertCanonicalTimelineOrder(items: readonly AnswerTimelineItem[]): void {
  let positioned = 0;
  let previous: AnswerTimelineCanonicalPosition | undefined;
  for (const item of items) {
    if (!item.canonicalPosition) continue;
    positioned += 1;
    const position = item.canonicalPosition;
    if (previous && (position.laneSequence < previous.laneSequence || position.laneSequence === previous.laneSequence && position.itemOrdinal <= previous.itemOrdinal)) {
      throw new Error("Answer timeline items are not in strictly increasing canonical order");
    }
    previous = position;
  }
  if (positioned !== 0 && positioned !== items.length) throw new Error("Answer timeline items must all carry canonical positions");
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
