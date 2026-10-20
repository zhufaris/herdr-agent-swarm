import { describe, expect, it } from "vitest";
import { foldFinalTraceChoiceEvidence, normalizeFinalTraceEnvelope } from "../src/domain/final-trace-envelope.js";

function reviewFence(value: Record<string, unknown>): string {
  return ["```herdr-choice-list", JSON.stringify(value), "```"].join("\n");
}

const citation = [
  "<oai-mem-citation>",
  "<citation_entries>",
  "MEMORY.md:1-1|note=[evidence]",
  "</citation_entries>",
  "<rollout_ids>",
  "019dbb13-b7a0-7000-8000-000000000001",
  "</rollout_ids>",
  "</oai-mem-citation>"
].join("\n");

describe("Final Trace Envelope", () => {
  it("normalizes a complete suffix even when a citation follows the choice", () => {
    const choice = {
      version: 3,
      choice: {
        question: "Approve?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve" },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise first" }]
      }
    };
    const markdown = [
      "Visible answer.",
      "",
      "<at id=ou_1234567890abcdef></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      reviewFence(choice),
      citation
    ].join("\n");

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.projectionMarkdown).toBe(`Visible answer.\n\n${citation}`);
    expect(normalized.presentationMarkdown).toBe("Visible answer.");
    expect(normalized.requesterSyntax).toMatchObject({ requested: true, request: { kind: "native-mention" } });
    expect(normalized.compatibilityChoice).toMatchObject({
      kind: "valid",
      decision: { protocolVersion: 3, intent: "human_review", choice: { question: "Approve?" } }
    });
  });

  it("normalizes the reported alternate review list into the canonical final envelope choice", () => {
    const reported = {
      version: 3,
      intent: "review",
      choices: [
        { id: "A", label: "批准 Gate 3", consequence: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
        { id: "B", label: "修改计划", consequence: "停在 Gate 3，修订 ticket plan 后重新审批" },
        { id: "C", label: "拒绝并停止", consequence: "保留隔离 worktree，不开始实现" }
      ]
    };
    const markdown = `Visible answer.\n\n$herdr-choice-list:herdr-choice-list\n${reviewFence(reported)}`;

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.presentationMarkdown).toBe("Visible answer.");
    expect(normalized.projectionMarkdown).toBe("Visible answer.");
    expect(normalized.compatibilityChoice).toEqual({
      kind: "valid",
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
    ["none", { version: 3 }, { protocolVersion: 3, intent: "none" }],
    ["review", {
      version: 3,
      choice: {
        question: "下一步？",
        defaultOption: { id: "approve", label: "批准", submitText: "批准" },
        alternatives: [{ id: "revise", label: "修改", submitText: "修改" }]
      }
    }, { protocolVersion: 3, intent: "human_review", choice: { question: "下一步？" } }]
  ])("ignores ordinary JSON examples and uses only the terminal fence: %s", (_name, terminalValue, expected) => {
    const ordinaryNestedExample = {
      version: 3,
      choice: {
        question: "展示用例",
        defaultOption: { id: "example", label: "展示", submitText: "展示" },
        alternatives: []
      }
    };
    const ordinaryLegacyExample = { version: 3, intent: "review", choices: [{ id: "A", consequence: "展示用例" }] };
    const markdown = [
      "Answer with protocol examples in the explanation.",
      "```json",
      JSON.stringify(ordinaryNestedExample),
      "```",
      "```json",
      JSON.stringify(ordinaryLegacyExample),
      "```",
      "<at id=ou_1234567890abcdef></at>",
      "$herdr-choice-list:herdr-choice-list",
      reviewFence(terminalValue)
    ].join("\n\n");

    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown }).compatibilityChoice).toMatchObject({
      kind: "valid",
      decision: expected
    });
  });

  it.each([
    ["compact", "<oai-mem-citation><citation_entries>entry</citation_entries><rollout_ids>id</rollout_ids></oai-mem-citation>"],
    ["mixed-whitespace", "<oai-mem-citation>  <citation_entries>entry</citation_entries>\t<rollout_ids>id</rollout_ids>  </oai-mem-citation>"]
  ])("preserves a complete %s terminal citation accepted by the compatibility grammar", (_kind, terminalCitation) => {
    const markdown = `Visible answer.\n\n${reviewFence({ version: 3 })}\n\n${terminalCitation}`;

    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown })).toMatchObject({
      projectionMarkdown: `Visible answer.\n\n${terminalCitation}`,
      presentationMarkdown: "Visible answer.",
      compatibilityChoice: { kind: "valid", decision: { protocolVersion: 3, intent: "none" } }
    });
  });

  it("lets a later explicit none clear an older textual review", () => {
    const review = reviewFence({
      version: 3,
      choice: {
        question: "Approve?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve" },
        alternatives: []
      }
    });
    const none = reviewFence({ version: 3 });

    expect(foldFinalTraceChoiceEvidence([
      { order: 10, text: review },
      { order: 20, text: none }
    ])).toEqual({ decision: "explicit-none" });
  });

  it("accepts a choice without its Skill invocation and rejects arbitrary trailing prose", () => {
    const choice = reviewFence({ version: 3 });
    expect(normalizeFinalTraceEnvelope({ finalMarkdown: `Visible answer.\n\n${choice}` })).toMatchObject({
      projectionMarkdown: "Visible answer.", compatibilityChoice: { kind: "valid", decision: { protocolVersion: 3, intent: "none" } }
    });
    expect(normalizeFinalTraceEnvelope({ finalMarkdown: `Visible answer.\n\n${choice}\n\nTrailing prose.` })).toEqual({
      projectionMarkdown: `Visible answer.\n\n${choice}\n\nTrailing prose.`,
      presentationMarkdown: `Visible answer.\n\n${choice}\n\nTrailing prose.`,
      requesterSyntax: { markdown: `Visible answer.\n\n${choice}\n\nTrailing prose.`, requested: false },
      compatibilityChoice: { kind: "invalid", reason: "nonterminal" }
    });
  });

  it.each([
    ["incomplete", "<oai-mem-citation>\n<citation_entries>entry</citation_entries>"],
    ["mid-body", `${citation}\n\nContinued answer.`],
    ["nested", "<oai-mem-citation>\n<citation_entries><unexpected>entry</unexpected></citation_entries>\n<rollout_ids>id</rollout_ids>\n</oai-mem-citation>"],
    ["code-fenced", `\`\`\`xml\n${citation}\n\`\`\``],
    ["duplicate", `${citation}\n\n${citation}`]
  ])("keeps %s citation-like text visible", (_kind, metadata) => {
    const markdown = `Visible answer.\n\n${metadata}`;
    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown })).toMatchObject({
      projectionMarkdown: markdown,
      presentationMarkdown: markdown
    });
  });

  it.each([
    ["malformed", "```herdr-choice-list\n{not-json}\n```", "invalid"],
    ["incomplete", "```herdr-choice-list\n{\"version\":3}", "invalid"],
    ["mid-body", `${reviewFence({ version: 3 })}\n\nContinued answer.`, "invalid"],
    ["duplicate", `${reviewFence({ version: 3 })}\n\n${reviewFence({ version: 3 })}`, "invalid"],
    ["oversized", `\`\`\`herdr-choice-list\n${"x".repeat(8_193)}`, "invalid"],
    ["code-fenced", `\`\`\`markdown\n${reviewFence({ version: 3 })}\n\`\`\``, "none"]
  ])("keeps %s choice-like text visible without granting it authority", (_kind, transport, expectedKind) => {
    const markdown = `Visible answer.\n\n${transport}`;
    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });
    expect(normalized.projectionMarkdown).toBe(markdown);
    expect(normalized.presentationMarkdown).toBe(markdown);
    expect(normalized.compatibilityChoice.kind).toBe(expectedKind);
  });

  it("normalizes requester syntax and invocation independently while preserving malformed choice text", () => {
    const malformed = "```herdr-choice-list\n{not-json}\n```";
    const markdown = [
      "Visible answer.",
      "",
      "<at id=ou_untrusted_but_well_formed></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      malformed,
      citation
    ].join("\n");

    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown })).toEqual({
      projectionMarkdown: `Visible answer.\n\n${malformed}\n\n${citation}`,
      presentationMarkdown: `Visible answer.\n\n${malformed}`,
      requesterSyntax: { markdown: `Visible answer.\n\n${malformed}`, requested: true, request: { kind: "native-mention" } },
      compatibilityChoice: { kind: "invalid", reason: "invalid-json" }
    });
  });

  it("removes only the invocation associated with a malformed terminal choice", () => {
    const malformed = "```herdr-choice-list\n{not-json}\n```";
    const markdown = [
      "Visible answer.",
      "",
      "Literal example:",
      "$herdr-choice-list:herdr-choice-list",
      "",
      "<at id=ou_untrusted_but_well_formed></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      malformed,
      citation
    ].join("\n");

    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown })).toEqual({
      projectionMarkdown: `Visible answer.\n\nLiteral example:\n$herdr-choice-list:herdr-choice-list\n\n${malformed}\n\n${citation}`,
      presentationMarkdown: `Visible answer.\n\nLiteral example:\n$herdr-choice-list:herdr-choice-list\n\n${malformed}`,
      requesterSyntax: { markdown: `Visible answer.\n\nLiteral example:\n$herdr-choice-list:herdr-choice-list\n\n${malformed}`, requested: true, request: { kind: "native-mention" } },
      compatibilityChoice: { kind: "invalid", reason: "invalid-json" }
    });
  });

  it("associates the invocation with the terminal malformed choice after an earlier visible choice example", () => {
    const visibleExample = reviewFence({ version: 3 });
    const malformed = "```herdr-choice-list\n{not-json}\n```";
    const markdown = [
      "Visible example:",
      visibleExample,
      "",
      "Continue with the actual envelope:",
      "$herdr-choice-list:herdr-choice-list",
      malformed
    ].join("\n");

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.compatibilityChoice.kind).toBe("invalid");
    expect(normalized.projectionMarkdown).toContain(visibleExample);
    expect(normalized.projectionMarkdown).toContain(malformed);
    expect(normalized.projectionMarkdown).not.toContain("$herdr-choice-list:herdr-choice-list");
  });

  it("preserves unrelated visible invocation lines when no terminal choice is present", () => {
    const markdown = [
      "Visible example:",
      "$herdr-choice-list:herdr-choice-list",
      "",
      "Still visible."
    ].join("\n");

    expect(normalizeFinalTraceEnvelope({ finalMarkdown: markdown })).toEqual({
      projectionMarkdown: markdown,
      presentationMarkdown: markdown,
      requesterSyntax: { markdown, requested: false },
      compatibilityChoice: { kind: "none" }
    });
  });

  it("classifies a maximum-size repeated citation opener input within a bounded time", () => {
    const token = "<oai-mem-citation>\n";
    const markdown = token.repeat(Math.floor((128 * 1024) / token.length));
    const startedAt = performance.now();

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.projectionMarkdown).toBe(markdown.trimEnd());
    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("finds the associated invocation in a large malformed envelope within a bounded time", () => {
    const invocation = "$herdr-choice-list:herdr-choice-list\n";
    const repeated = invocation.repeat(Math.floor((256 * 1024) / invocation.length));
    const markdown = `Visible answer.\n${repeated}\`\`\`herdr-choice-list\n{not-json}\n\`\`\``;
    const startedAt = performance.now();

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.compatibilityChoice).toEqual({ kind: "invalid", reason: "invalid-json" });
    expect(normalized.projectionMarkdown).toContain("```herdr-choice-list\n{not-json}\n```");
    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("is idempotent for derived projection and presentation copies", () => {
    const input = `Visible answer.\n\n<at id=ou_1234567890abcdef></at>\n\n$herdr-choice-list:herdr-choice-list\n${reviewFence({ version: 3 })}\n\n${citation}`;
    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: input });
    expect(normalizeFinalTraceEnvelope({ finalMarkdown: normalized.projectionMarkdown })).toMatchObject({
      projectionMarkdown: normalized.projectionMarkdown,
      presentationMarkdown: normalized.presentationMarkdown
    });
    expect(normalizeFinalTraceEnvelope({ accumulatedMarkdown: normalized.presentationMarkdown })).toMatchObject({
      projectionMarkdown: normalized.presentationMarkdown,
      presentationMarkdown: normalized.presentationMarkdown
    });
  });

  it("preserves the exact bytes of a valid terminal citation in projection", () => {
    const crlfCitation = citation.replace(/\n/g, "\r\n");
    const normalized = normalizeFinalTraceEnvelope({
      finalMarkdown: `Visible answer.\r\n\r\n${crlfCitation}`
    });

    expect(normalized.projectionMarkdown.endsWith(crlfCitation)).toBe(true);
    expect(normalized.presentationMarkdown).toBe("Visible answer.");
  });

  it("parses a complete CRLF envelope while preserving the raw citation", () => {
    const crlfCitation = citation.replace(/\n/g, "\r\n");
    const markdown = [
      "Visible answer.",
      "",
      "<at id=ou_1234567890abcdef></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      reviewFence({ version: 3 }),
      crlfCitation
    ].join("\r\n");

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.compatibilityChoice).toMatchObject({
      kind: "valid", decision: { protocolVersion: 3, intent: "none" }
    });
    expect(normalized.requesterSyntax).toMatchObject({ requested: true, request: { kind: "native-mention" } });
    expect(normalized.projectionMarkdown.endsWith(crlfCitation)).toBe(true);
    expect(normalized.presentationMarkdown).toBe("Visible answer.");
  });

  it("parses a complete bare-CR envelope while preserving the raw citation", () => {
    const crCitation = citation.replace(/\n/g, "\r");
    const markdown = [
      "Visible answer.",
      "",
      "<at id=ou_1234567890abcdef></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      reviewFence({ version: 3 }),
      crCitation
    ].join("\r");

    const normalized = normalizeFinalTraceEnvelope({ finalMarkdown: markdown });

    expect(normalized.compatibilityChoice).toMatchObject({
      kind: "valid", decision: { protocolVersion: 3, intent: "none" }
    });
    expect(normalized.requesterSyntax).toMatchObject({ requested: true, request: { kind: "native-mention" } });
    expect(normalized.projectionMarkdown.endsWith(crCitation)).toBe(true);
    expect(normalized.presentationMarkdown).toBe("Visible answer.");
  });

  it("folds only non-truncated v2/v3 choices in canonical order", () => {
    const v1 = reviewFence({ version: 1, default: "approve", options: [
      { id: "approve", label: "Approve", message: "default" }, { id: "revise", label: "Revise", message: "Revise" }
    ] });
    const review = reviewFence({
      version: 2, intent: "human_review", question: "Approve?", default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    });
    const oversized = `\`\`\`herdr-choice-list\n${"x".repeat(8_193)}`;
    expect(foldFinalTraceChoiceEvidence([
      { order: 30, text: review },
      { order: 10, text: v1 },
      { order: 20, text: review, truncated: true },
      { order: 40, text: "not transport" },
      { order: 50, text: oversized }
    ])).toMatchObject({ decision: "selected", choice: { question: "Approve?" } });
  });

  it("ignores duplicated lane positions rather than inventing a textual decision", () => {
    const none = reviewFence({ version: 3 });
    expect(foldFinalTraceChoiceEvidence([
      { order: 10, text: none },
      { order: 10, text: none }
    ])).toEqual({ decision: "none" });
  });

  it("does not fold duplicated reserved fences into a text decision", () => {
    const duplicated = `${reviewFence({ version: 3 })}\n\n${reviewFence({ version: 3 })}`;
    expect(foldFinalTraceChoiceEvidence([{ order: 10, text: duplicated }])).toEqual({ decision: "none" });
  });
});
