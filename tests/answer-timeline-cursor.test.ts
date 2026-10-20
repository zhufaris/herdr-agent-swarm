import { describe, expect, it } from "vitest";
import { answerTimelineCursorAdvances, compareAnswerTimelineCursors, sameAnswerTimelineCursor } from "../src/domain/answer-timeline-cursor.js";

describe("Answer timeline cursor ordering", () => {
  it("orders items, Tool sections, and offsets", () => {
    expect(answerTimelineCursorAdvances({ itemIndex: 1, markdownOffset: 0, section: "command", offset: 90 }, { itemIndex: 1, markdownOffset: 0, section: "result", offset: 0 })).toBe(true);
    expect(answerTimelineCursorAdvances({ itemIndex: 1, markdownOffset: 0, section: "result", offset: 2 }, { itemIndex: 2, markdownOffset: 0 })).toBe(true);
    expect(compareAnswerTimelineCursors({ itemIndex: 3, markdownOffset: 5 }, { itemIndex: 3, markdownOffset: 8 })).toBeLessThan(0);
  });

  it("rejects equal and regressing positions while preserving legacy equality", () => {
    expect(sameAnswerTimelineCursor({ itemIndex: 2, markdownOffset: 4 }, { itemIndex: 2, markdownOffset: 4, section: "message", offset: 4 })).toBe(true);
    expect(answerTimelineCursorAdvances({ itemIndex: 2, markdownOffset: 4 }, { itemIndex: 2, markdownOffset: 4 })).toBe(false);
    expect(answerTimelineCursorAdvances({ itemIndex: 2, markdownOffset: 5 }, { itemIndex: 2, markdownOffset: 4 })).toBe(false);
  });
});
