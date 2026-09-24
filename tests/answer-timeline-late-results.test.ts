import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lateAnswerTimelineResults } from "../src/domain/answer-timeline-late-results.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

const running: AnswerTimelineItem = { kind: "tool", id: "tool:one", sequence: 2, category: "command", label: "npm test", command: "npm test", state: "running" };
const fingerprint = createHash("sha256").update(JSON.stringify(running)).digest("hex");

describe("late Answer timeline results", () => {
  it("links a changed terminal Tool to its frozen source page", () => {
    const completed: AnswerTimelineItem = { ...running, state: "succeeded", resultPreview: "passed" };
    expect(lateAnswerTimelineResults([completed], [{ pageIndex: 0, id: running.id, fingerprint }], 1)).toEqual([{
      ...completed, id: "late:tool:one", sequence: -1, label: "npm test（更新自第 1 页）"
    }]);
  });

  it("does not duplicate unchanged, running, or unrelated Tool items", () => {
    expect(lateAnswerTimelineResults([running], [{ pageIndex: 0, id: running.id, fingerprint }], 1)).toEqual([]);
    expect(lateAnswerTimelineResults([{ ...running, id: "tool:two", state: "failed" }], [{ pageIndex: 0, id: running.id, fingerprint }], 1)).toEqual([]);
  });

  it("does not repeat a linked completion after a later page delivered it", () => {
    const completed: AnswerTimelineItem = { ...running, state: "succeeded", resultPreview: "passed" };
    expect(lateAnswerTimelineResults([completed], [
      { pageIndex: 0, id: running.id, fingerprint },
      { pageIndex: 1, id: "late:tool:one", fingerprint: "linked" }
    ], 2)).toEqual([]);
  });
});
