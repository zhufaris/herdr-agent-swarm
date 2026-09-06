import { describe, expect, it } from "vitest";
import { workerTaskInteraction } from "../src/domain/worker-task-interaction.js";

describe("Worker task interaction policy", () => {
  it("maps running replies to exact-turn steering", () => {
    expect(workerTaskInteraction("running")).toMatchObject({ replyIntent: "steer", actionLabel: "补充当前任务" });
  });
  it.each(["completed", "failed", "cancelled"] as const)("maps %s replies to FIFO follow-up", (phase) => {
    expect(workerTaskInteraction(phase)).toMatchObject({ replyIntent: "followup", actionLabel: "继续这个任务" });
  });
  it.each(["queued", "preparing", "blocked", "dispatch-uncertain"] as const)("rejects unavailable %s replies", (phase) => {
    expect(workerTaskInteraction(phase)).toMatchObject({ replyIntent: "reject", actionLabel: null });
  });
  it("directs blocked work to the local Herdr pane", () => {
    expect(workerTaskInteraction("blocked").guidance).toContain("对应 Pane");
  });
  it("exposes interruption only for a running task", () => {
    expect(workerTaskInteraction("running").canInterrupt).toBe(true);
    expect(workerTaskInteraction("blocked").canInterrupt).toBe(false);
  });
});
