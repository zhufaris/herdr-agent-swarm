import { describe, expect, it } from "vitest";
import { workerTaskInteraction } from "../src/domain/worker-task-interaction.js";

describe("Worker task interaction policy", () => {
  it.each(["running", "blocked"] as const)("maps %s replies to exact-turn steering", (phase) => {
    expect(workerTaskInteraction(phase)).toMatchObject({ replyIntent: "steer", actionLabel: "补充当前任务", guidance: expect.stringContaining("直接回复卡片仍会进入 Primary") });
  });
  it.each(["completed", "failed", "cancelled"] as const)("maps %s replies to FIFO follow-up", (phase) => {
    expect(workerTaskInteraction(phase)).toMatchObject({ replyIntent: "followup", actionLabel: "继续这个任务", guidance: expect.stringContaining("直接回复卡片仍会进入 Primary") });
  });
  it.each(["queued", "preparing", "dispatch-uncertain"] as const)("rejects ambiguous %s replies", (phase) => {
    expect(workerTaskInteraction(phase)).toMatchObject({ replyIntent: "reject", actionLabel: null });
  });
  it("exposes interruption only for a running task", () => {
    expect(workerTaskInteraction("running").canInterrupt).toBe(true);
    expect(workerTaskInteraction("blocked").canInterrupt).toBe(false);
  });
});
