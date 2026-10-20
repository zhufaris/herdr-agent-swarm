import type { AnswerTimelineItem } from "./answer-timeline.js";

export interface AnswerSegment {
  aggregateKind: "primary-run" | "worker-turn";
  aggregateId: string;
  segmentIndex: number;
  sourceHumanItemId: string | null;
  requestText: string;
  startAfterSequence: number;
  endBeforeSequence: number | null;
  endBeforeItemId: string | null;
  state: "open" | "closed";
}

export interface AnswerSegmentBoundary {
  sourceHumanItemId: string;
  requestText: string;
  sequence: number;
}

export function findUnmaterializedHumanBoundaries(
  items: readonly AnswerTimelineItem[],
  materializedSourceIds: ReadonlySet<string>,
  activationSequence: number,
): AnswerSegmentBoundary[] {
  const boundaries: AnswerSegmentBoundary[] = [];
  for (const item of items) {
    if (item.kind !== "human_message") continue;
    if (item.sequence <= activationSequence) continue;
    if (materializedSourceIds.has(item.id)) continue;
    boundaries.push({ sourceHumanItemId: item.id, requestText: item.markdown, sequence: item.sequence });
  }
  return boundaries.sort((left, right) => left.sequence - right.sequence || left.sourceHumanItemId.localeCompare(right.sourceHumanItemId));
}

export function itemsForAnswerSegment(items: readonly AnswerTimelineItem[], segment: AnswerSegment): AnswerTimelineItem[] {
  const startBoundaryId = segment.sourceHumanItemId;
  const hasStartId = typeof startBoundaryId === "string" && startBoundaryId.length > 0;
  const startBoundary = hasStartId ? { sequence: segment.startAfterSequence, id: startBoundaryId } : null;
  const endBoundary = segment.endBeforeSequence === null ? null : { sequence: segment.endBeforeSequence, id: segment.endBeforeItemId ?? "" };

  return items.filter((item) => {
    if (item.kind === "human_message") return false;
    if (startBoundary !== null && !tupleGreater({ sequence: item.sequence, id: item.id }, startBoundary)) return false;
    if (startBoundary === null && item.sequence <= segment.startAfterSequence) return false;
    return endBoundary === null ? true : tupleLess({ sequence: item.sequence, id: item.id }, endBoundary);
  });
}

function tupleLess(left: { sequence: number; id: string }, right: { sequence: number; id: string }): boolean {
  return left.sequence < right.sequence || (left.sequence === right.sequence && left.id.localeCompare(right.id) < 0);
}

function tupleGreater(left: { sequence: number; id: string }, right: { sequence: number; id: string }): boolean {
  return left.sequence > right.sequence || (left.sequence === right.sequence && left.id.localeCompare(right.id) > 0);
}
