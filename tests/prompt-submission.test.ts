import { describe, expect, it } from "vitest";
import { classifyPromptSubmissionFailure } from "../src/domain/prompt-submission.js";

describe("prompt submission outcomes", () => {
  it.each([
    ["agent_prompt_not_started", "not_started"],
    ["agent_prompt_rejected", "rejected"],
    ["agent_not_ready", "rejected"],
    ["agent_prompt_stalled", "uncertain"],
    ["agent_prompt_uncertain", "uncertain"]
  ] as const)("classifies %s as %s", (code, kind) => {
    expect(classifyPromptSubmissionFailure(new Error(`Command failed: ${JSON.stringify({ error: { code, message: "bounded" } })}`))).toMatchObject({ kind });
  });

  it("does not invent an outcome for an unstructured failure", () => {
    expect(classifyPromptSubmissionFailure(new Error("socket closed"))).toBeNull();
  });
});
