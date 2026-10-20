import type { AnswerTimelineCursor } from "./delivery.js";

const SECTION_ORDER = { message: 0, command: 1, result: 2 } as const;

/** Compares durable timeline positions. Negative means left precedes right. */
export function compareAnswerTimelineCursors(left: AnswerTimelineCursor, right: AnswerTimelineCursor): number {
  if (left.itemIndex !== right.itemIndex) return left.itemIndex - right.itemIndex;
  const leftSection = left.section ?? "message";
  const rightSection = right.section ?? "message";
  if (leftSection !== rightSection) return SECTION_ORDER[leftSection] - SECTION_ORDER[rightSection];
  return effectiveOffset(left) - effectiveOffset(right);
}

export function answerTimelineCursorAdvances(previous: AnswerTimelineCursor, next: AnswerTimelineCursor): boolean {
  return compareAnswerTimelineCursors(previous, next) < 0;
}

export function sameAnswerTimelineCursor(left: AnswerTimelineCursor, right: AnswerTimelineCursor): boolean {
  return compareAnswerTimelineCursors(left, right) === 0;
}

function effectiveOffset(cursor: AnswerTimelineCursor): number {
  return cursor.offset ?? cursor.markdownOffset;
}
