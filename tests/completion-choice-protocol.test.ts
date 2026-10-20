import { describe, expect, it } from "vitest";
import { assistantMessageFromFinalMessageCompletionChoice, finalMessageCompletionChoiceFromTraceEndReviewDecision, inspectCompletionChoiceProtocol, inspectTraceEndReviewProtocol, sanitizeCompletionChoiceMarkdown, selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../src/domain/completion-choice.js";

function block(overrides: Record<string, unknown> = {}): string {
  return [
    "```herdr-choice-list",
    JSON.stringify({
      version: 1,
      default: "option-1",
      options: [
        { id: "option-1", label: "方案 1（默认）", message: "default" },
        { id: "option-2", label: "方案 2", message: "2" }
      ],
      ...overrides
    }, null, 2),
    "```"
  ].join("\n");
}

function reviewBlock(value: Record<string, unknown>): string {
  return ["```herdr-choice-list", JSON.stringify(value, null, 2), "```"].join("\n");
}

const reportedReviewList = {
  version: 3,
  intent: "review",
  choices: [
    { id: "A", label: "批准 Gate 3", consequence: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
    { id: "B", label: "修改计划", consequence: "停在 Gate 3，修订 ticket plan 后重新审批" },
    { id: "C", label: "拒绝并停止", consequence: "保留隔离 worktree，不开始实现" }
  ]
};

describe("completion choice protocol", () => {
  it("extracts one physical-terminal choice block and preserves the visible answer", () => {
    const result = inspectCompletionChoiceProtocol(`完成分析。\n\n${block()}\n`, { terminal: true });

    expect(result).toEqual({
      kind: "valid",
      visibleMarkdown: "完成分析。",
      specification: {
        version: 1,
        defaultOptionId: "option-1",
        options: [
          { id: "option-1", label: "方案 1（默认）", message: "default" },
          { id: "option-2", label: "方案 2", message: "2" }
        ]
      }
    });
  });

  it("withholds an unfinished reserved fence only while the answer is streaming", () => {
    const markdown = "可见答案\n\n```herdr-choice-list\n{\"version\":1";
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: false })).toEqual({
      kind: "pending",
      visibleMarkdown: "可见答案",
      withheldMarkdown: "```herdr-choice-list\n{\"version\":1"
    });
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "可见答案",
      reason: "unterminated"
    });
  });

  it.each([
    ["unsupported-version", { version: 2 }],
    ["missing-default", { default: "missing" }],
    ["invalid-default-message", { options: [{ id: "option-1", label: "One", message: "1" }, { id: "option-2", label: "Two", message: "2" }] }],
    ["too-few-options", { options: [{ id: "option-1", label: "One", message: "default" }] }],
    ["duplicate-ids", { options: [{ id: "same", label: "One", message: "default" }, { id: "same", label: "Two", message: "2" }] }],
    ["invalid-id", { options: [{ id: "bad id", label: "One", message: "default" }, { id: "two", label: "Two", message: "2" }] }],
    ["empty-label", { options: [{ id: "one", label: "   ", message: "default" }, { id: "two", label: "Two", message: "2" }] }],
    ["empty-message", { options: [{ id: "one", label: "One", message: "" }, { id: "two", label: "Two", message: "2" }] }]
  ])("strips invalid terminal protocol: %s", (_name, overrides) => {
    const markdown = `Answer\n\n${block(overrides)}`;
    const result = inspectCompletionChoiceProtocol(markdown, { terminal: true });
    expect(result.kind).toBe("invalid");
    expect(result.visibleMarkdown).toBe("Answer");
  });

  it("strips a non-terminal reserved block without accepting it", () => {
    const markdown = `${block()}\n\nMore prose`;
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({ kind: "invalid", visibleMarkdown: "More prose", reason: "nonterminal" });
  });

  it("treats an inline fence-like substring as ordinary Markdown", () => {
    const markdown = `Explain \`${block()}\` here`;
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({ kind: "none", visibleMarkdown: markdown });
  });

  it("strips an oversized streaming tail", () => {
    const markdown = `Answer\n\n\`\`\`herdr-choice-list\n${"x".repeat(8_193)}`;
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: false })).toEqual({ kind: "invalid", visibleMarkdown: "Answer", reason: "oversized" });
  });

  it("rejects and strips multiple reserved blocks", () => {
    const markdown = `${block()}\n\n${block()}`;
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({ kind: "invalid", visibleMarkdown: "", reason: "multiple-blocks" });
  });

  it("enforces the complete block byte bound", () => {
    const markdown = `Answer\n\n${block({ options: [
      { id: "one", label: "One", message: "x".repeat(5_000) },
      { id: "two", label: "Two", message: "2" }
    ] })}`;
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({ kind: "invalid", visibleMarkdown: "Answer", reason: "oversized" });
  });

  it("leaves arbitrary nonreserved code fences unchanged", () => {
    const markdown = "Before\n\n```json\n{\"version\":2}\n```\n\n```herdr-choice-list-extra\nsecret\n```\n\nAfter";
    expect(sanitizeCompletionChoiceMarkdown(markdown)).toBe(markdown);
  });

  it.each([
    ["a longer backtick fence", "````markdown", "````"],
    ["a tilde fence", "~~~markdown", "~~~"]
  ])("preserves a literal choice-list example inside %s", (_name, openingFence, closingFence) => {
    const markdown = [
      "Use this literal example:",
      "",
      openingFence,
      block(),
      closingFence
    ].join("\n");

    expect(sanitizeCompletionChoiceMarkdown(markdown)).toBe(markdown);
    expect(inspectCompletionChoiceProtocol(markdown, { terminal: true })).toEqual({ kind: "none", visibleMarkdown: markdown });
  });

  it("ignores fenced examples before accepting a genuine top-level terminal protocol", () => {
    const example = ["````markdown", reviewBlock({ version: 2, intent: "none" }), "````"].join("\n");
    const markdown = `${example}\n\n${reviewBlock({ version: 2, intent: "none" })}`;

    expect(inspectTraceEndReviewProtocol(markdown, { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: example,
      decision: { protocolVersion: 2, intent: "none" }
    });
  });
});

describe("trace-end review protocol", () => {
  it("normalizes the bounded alternate version 3 review list reported by a final trace", () => {
    expect(inspectTraceEndReviewProtocol(reviewBlock(reportedReviewList), { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: "",
      decision: {
        protocolVersion: 3,
        intent: "human_review",
        choice: {
          question: "请选择下一步。",
          defaultOption: { id: "A", label: "批准 Gate 3", submitText: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
          alternatives: [
            { id: "B", label: "修改计划", submitText: "停在 Gate 3，修订 ticket plan 后重新审批" },
            { id: "C", label: "拒绝并停止", submitText: "保留隔离 worktree，不开始实现" }
          ]
        }
      }
    });
  });

  it.each([
    ["unknown top-level field", { ...reportedReviewList, extra: true }, "invalid-review-list-fields"],
    ["unsupported intent", { ...reportedReviewList, intent: "human_review" }, "invalid-intent"],
    ["no choices", { ...reportedReviewList, choices: [] }, "invalid-option-count"],
    ["too many choices", { ...reportedReviewList, choices: Array.from({ length: 5 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}`, consequence: `Choose ${index}` })) }, "invalid-option-count"],
    ["duplicate ids", { ...reportedReviewList, choices: [{ id: "same", label: "One", consequence: "One" }, { id: "same", label: "Two", consequence: "Two" }] }, "duplicate-option-id"],
    ["reserved id", { ...reportedReviewList, choices: [{ id: "ignore", label: "Ignore", consequence: "Ignore" }] }, "reserved-option-id"],
    ["invalid id", { ...reportedReviewList, choices: [{ id: "bad id", label: "Approve", consequence: "Approve" }] }, "invalid-option-id"],
    ["unknown option field", { ...reportedReviewList, choices: [{ id: "A", label: "Approve", consequence: "Approve", extra: true }] }, "invalid-option-fields"],
    ["empty label", { ...reportedReviewList, choices: [{ id: "A", label: " ", consequence: "Approve" }] }, "invalid-option-label"],
    ["oversized label", { ...reportedReviewList, choices: [{ id: "A", label: "x".repeat(41), consequence: "Approve" }] }, "oversized"],
    ["empty consequence", { ...reportedReviewList, choices: [{ id: "A", label: "Approve", consequence: " " }] }, "invalid-option-submit-text"],
    ["oversized consequence", { ...reportedReviewList, choices: [{ id: "A", label: "Approve", consequence: "x".repeat(2_001) }] }, "oversized"],
    ["legacy sentinel consequence", { ...reportedReviewList, choices: [{ id: "A", label: "Approve", consequence: "default" }] }, "sentinel-submit-text"]
  ])("fails closed for alternate version 3 review lists with %s", (_name, value, reason) => {
    expect(inspectTraceEndReviewProtocol(reviewBlock(value), { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "",
      reason
    });
  });

  it("accepts a version 3 choice with an embedded default option and no sentinel", () => {
    expect(inspectTraceEndReviewProtocol(reviewBlock({
      version: 3,
      choice: {
        question: "是否批准？",
        defaultOption: { id: "approve", label: "批准并继续", submitText: "批准并继续" },
        alternatives: [{ id: "revise", label: "要求修改", submitText: "请先修改设计" }]
      }
    }), { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: "",
      decision: {
        protocolVersion: 3,
        intent: "human_review",
        choice: {
          question: "是否批准？",
          defaultOption: { id: "approve", label: "批准并继续", submitText: "批准并继续" },
          alternatives: [{ id: "revise", label: "要求修改", submitText: "请先修改设计" }]
        }
      }
    });
  });

  it("accepts a version 3 fence with no choice as an explicit no-review decision", () => {
    expect(inspectTraceEndReviewProtocol(reviewBlock({ version: 3 }), { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: "",
      decision: { protocolVersion: 3, intent: "none" }
    });
  });

  it.each([
    ["duplicate default and alternative ids", {
      version: 3,
      choice: {
        question: "Choose", defaultOption: { id: "approve", label: "Approve", submitText: "Approve" },
        alternatives: [{ id: "approve", label: "Revise", submitText: "Revise" }]
      }
    }, "duplicate-option-id"],
    ["reserved default id", {
      version: 3,
      choice: {
        question: "Choose", defaultOption: { id: "ignore", label: "Ignore", submitText: "Ignore" }, alternatives: []
      }
    }, "reserved-option-id"],
    ["legacy sentinel submit text", {
      version: 3,
      choice: {
        question: "Choose", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: []
      }
    }, "sentinel-submit-text"],
    ["dangling legacy fields", { version: 3, intent: "none" }, "invalid-v3-fields"]
  ])("fails closed for invalid v3 %s", (_name, value, reason) => {
    expect(inspectTraceEndReviewProtocol(reviewBlock(value), { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "",
      reason
    });
  });

  it("converts only a valid v2 Human Review decision to final-message metadata", () => {
    expect(finalMessageCompletionChoiceFromTraceEndReviewDecision({
      protocolVersion: 2,
      intent: "human_review",
      choice: { question: "Approve?", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: [] }
    })).toEqual({
      version: 2,
      intent: "human_review",
      question: "Approve?",
      default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    });
    expect(finalMessageCompletionChoiceFromTraceEndReviewDecision({ protocolVersion: 2, intent: "none" })).toBeUndefined();
    expect(finalMessageCompletionChoiceFromTraceEndReviewDecision({
      protocolVersion: 2,
      intent: "human_review",
      choice: { question: "", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: [] }
    })).toBeUndefined();
    expect(finalMessageCompletionChoiceFromTraceEndReviewDecision({
      protocolVersion: 1,
      intent: "human_review",
      choice: { question: "Approve?", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: [] }
    })).toBeUndefined();
  });

  it("constructs a versioned structural Assistant Message from native compatibility metadata", () => {
    expect(assistantMessageFromFinalMessageCompletionChoice("Visible answer.", {
      version: 2,
      intent: "human_review",
      question: "Approve?",
      default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    })).toEqual({
      schemaVersion: 2,
      text: "Visible answer.",
      choice: {
        question: "Approve?",
        defaultOption: { id: "approve", label: "Approve", submitText: "default" },
        alternatives: []
      }
    });
  });

  it("accepts an explicit version 2 none decision and hides the protocol", () => {
    expect(inspectTraceEndReviewProtocol(`完成。\n\n${reviewBlock({ version: 2, intent: "none" })}`, { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: "完成。",
      decision: { protocolVersion: 2, intent: "none" }
    });
  });

  it("normalizes a version 2 Human Review declaration", () => {
    expect(inspectTraceEndReviewProtocol(reviewBlock({
      version: 2,
      intent: "human_review",
      question: "是否批准强制重启？",
      default: "approve",
      options: [
        { id: "approve", label: "批准重启", message: "default" },
        { id: "cancel", label: "暂不重启", message: "暂不重启" }
      ]
    }), { terminal: true })).toEqual({
      kind: "valid",
      visibleMarkdown: "",
      decision: {
        protocolVersion: 2,
        intent: "human_review",
        choice: {
          question: "是否批准强制重启？",
          defaultOption: { id: "approve", label: "批准重启", submitText: "default" },
          alternatives: [{ id: "cancel", label: "暂不重启", submitText: "暂不重启" }]
        }
      }
    });
  });

  it.each([1, 4])("accepts %i business option(s) before the system adds Ignore", (count) => {
    const options = Array.from({ length: count }, (_, index) => ({
      id: `item-${index + 1}`,
      label: `Item ${index + 1}`,
      message: index === 0 ? "default" : String(index + 1)
    }));
    expect(inspectTraceEndReviewProtocol(reviewBlock({
      version: 2,
      intent: "human_review",
      question: "Choose one",
      default: "item-1",
      options
    }), { terminal: true })).toMatchObject({ kind: "valid", decision: { intent: "human_review", choice: { defaultOption: { id: "item-1", submitText: "default" } } } });
  });

  it("maps a valid version 1 choice list to a compatibility Human Review decision", () => {
    const result = inspectTraceEndReviewProtocol(block(), { terminal: true });
    expect(result).toMatchObject({
      kind: "valid",
      decision: {
        protocolVersion: 1,
        intent: "human_review",
        choice: { defaultOption: { id: "option-1" } }
      }
    });
  });

  it.each([
    ["extra-none-fields", { version: 2, intent: "none", question: "No" }],
    ["missing-question", { version: 2, intent: "human_review", default: "one", options: [{ id: "one", label: "One", message: "default" }] }],
    ["empty-question", { version: 2, intent: "human_review", question: "   ", default: "one", options: [{ id: "one", label: "One", message: "default" }] }],
    ["oversized-question", { version: 2, intent: "human_review", question: "x".repeat(2_001), default: "one", options: [{ id: "one", label: "One", message: "default" }] }],
    ["too-many-options", { version: 2, intent: "human_review", question: "Choose", default: "one", options: Array.from({ length: 5 }, (_, index) => ({ id: index === 0 ? "one" : `item-${index}`, label: `Item ${index}`, message: index === 0 ? "default" : String(index) })) }],
    ["reserved-ignore", { version: 2, intent: "human_review", question: "Choose", default: "one", options: [{ id: "one", label: "One", message: "default" }, { id: "ignore", label: "Ignore", message: "ignore" }] }]
  ])("rejects invalid version 2 input and hides its reserved terminal fence: %s", (_name, value) => {
    const result = inspectTraceEndReviewProtocol(`Visible answer\n\n${reviewBlock(value)}`, { terminal: true });
    expect(result.kind).toBe("invalid");
    expect(result.visibleMarkdown).toBe("Visible answer");
  });

  it("strips a non-terminal reserved block without authorizing its decision", () => {
    const markdown = `${reviewBlock({ version: 2, intent: "none" })}\n\nVisible epilogue`;
    expect(inspectTraceEndReviewProtocol(markdown, { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "Visible epilogue",
      reason: "nonterminal"
    });
  });

  it("fails closed on duplicate terminal review fences while preserving preceding prose", () => {
    const markdown = [
      "Opening answer.",
      reviewBlock({ version: 2, intent: "none" }),
      "Intervening explanation must remain visible.",
      reviewBlock({ version: 2, intent: "none" })
    ].join("\n\n");

    expect(inspectTraceEndReviewProtocol(markdown, { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "Opening answer.\n\nIntervening explanation must remain visible.",
      reason: "multiple-blocks"
    });
  });

  it("strips an unterminated reserved opener at terminal settlement", () => {
    const markdown = "Visible answer.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"none\"}";
    expect(inspectTraceEndReviewProtocol(markdown, { terminal: true })).toEqual({
      kind: "invalid",
      visibleMarkdown: "Visible answer.",
      reason: "unterminated"
    });
  });

  it("replaces invalid accumulated transport with one protocol-only repair", () => {
    const repair = reviewBlock({ version: 2, intent: "none" });
    const invalidRepair = "```herdr-choice-list\n{bad";
    const accumulated = `Original answer\n\n${reviewBlock({ version: 2, intent: "none" })}\n\nPreserved epilogue`;
    expect(selectCompletionChoiceTerminalAnswer(reviewBlock({ version: 2, intent: "none" }), "Original answer")).toBe("Original answer");
    expect(selectCompletionChoiceTerminalAnswer(repair, accumulated)).toBe("Original answer\n\nPreserved epilogue");
    expect(selectCompletionChoiceTerminalInput(repair, accumulated)).toBe(`Original answer\n\nPreserved epilogue\n\n${repair}`);
    expect(selectCompletionChoiceTerminalInput(repair, `Original answer\n\n${repair}`)).toBe(`Original answer\n\n${repair}`);
    expect(selectCompletionChoiceTerminalAnswer(invalidRepair, "Original answer")).toBe("Original answer");
    expect(selectCompletionChoiceTerminalInput(invalidRepair, "Original answer")).toBe(`Original answer\n\n${invalidRepair}`);
  });

  it("preserves an accumulated terminal review when task completion repeats only its visible answer", () => {
    const visibleAnswer = "请选择测试结果。";
    const protocol = reviewBlock({
      version: 2,
      intent: "human_review",
      question: "本次测试是否通过？",
      default: "passed",
      options: [
        { id: "passed", label: "通过", message: "default" },
        { id: "failed", label: "不通过", message: "failed" }
      ]
    });
    const accumulatedAnswer = `${visibleAnswer}\n\n${protocol}`;

    expect(selectCompletionChoiceTerminalInput(visibleAnswer, accumulatedAnswer)).toBe(accumulatedAnswer);
  });

  it("does not attach an accumulated terminal review to a different final answer", () => {
    const staleAnswer = `Earlier answer.\n\n${reviewBlock({
      version: 2,
      intent: "human_review",
      question: "Continue?",
      default: "yes",
      options: [{ id: "yes", label: "Yes", message: "default" }]
    })}`;

    expect(selectCompletionChoiceTerminalInput("Different final answer.", staleAnswer)).toBe("Different final answer.");
  });
});
