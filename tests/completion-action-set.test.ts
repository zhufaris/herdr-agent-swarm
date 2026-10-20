import { describe, expect, it } from "vitest";
import { completionReviewActionSetIdentity } from "../src/domain/completion-action-set.js";

describe("Completion Review Action Set identity", () => {
  it("is deterministic and changes with every owner identity component", () => {
    const input = { ownerKind: "primary-segment" as const, ownerId: "segment-1", ownerGeneration: 3 };
    const identity = completionReviewActionSetIdentity(input.ownerKind, input.ownerId, input.ownerGeneration);

    expect(identity).toMatch(/^completion-review:v3:[a-f0-9]{64}$/);
    expect(completionReviewActionSetIdentity(input.ownerKind, input.ownerId, input.ownerGeneration)).toBe(identity);
    expect(completionReviewActionSetIdentity("primary-prompt", input.ownerId, input.ownerGeneration)).not.toBe(identity);
    expect(completionReviewActionSetIdentity(input.ownerKind, "segment-2", input.ownerGeneration)).not.toBe(identity);
    expect(completionReviewActionSetIdentity(input.ownerKind, input.ownerId, 4)).not.toBe(identity);
    expect(() => completionReviewActionSetIdentity(input.ownerKind, "", input.ownerGeneration)).toThrow(/owner/i);
    expect(() => completionReviewActionSetIdentity(input.ownerKind, " segment-1", input.ownerGeneration)).toThrow(/owner/i);
    expect(() => completionReviewActionSetIdentity(input.ownerKind, "segment-1 ", input.ownerGeneration)).toThrow(/owner/i);
    expect(() => completionReviewActionSetIdentity("unknown" as never, input.ownerId, input.ownerGeneration)).toThrow(/ownerkind/i);
    expect(() => completionReviewActionSetIdentity(input.ownerKind, input.ownerId, 0)).toThrow(/generation/i);
    expect(() => completionReviewActionSetIdentity(input.ownerKind, input.ownerId, 1.5)).toThrow(/generation/i);
  });
});
