import { describe, expect, it } from "vitest";
import { materializeFeishuRichText } from "../src/gateways/feishu/rich-text.js";
import { initialRichTextAnswerPayload } from "../src/domain/rich-text.js";

describe("Feishu rich-text materialization", () => {
  it("wraps canonical Markdown in an ordinary post md element", () => {
    expect(materializeFeishuRichText({ title: "回答（续 2）", markdown: "Hello **world** 💭" })).toEqual({
      zh_cn: {
        title: "回答（续 2）",
        content: [
          [{ tag: "md", text: "Hello **world** 💭" }]
        ]
      }
    });
  });

  it("uses an empty title for the first page", () => {
    expect(materializeFeishuRichText({ markdown: "正在生成… 💭" })).toEqual({
      zh_cn: { title: "", content: [[{ tag: "md", text: "正在生成… 💭" }]] }
    });
  });

  it("preserves a metadata title on the initial placeholder reply", () => {
    expect(initialRichTextAnswerPayload(0, 0, "element-1", "🤖 bridge · abcd")).toMatchObject({
      document: { title: "🤖 bridge · abcd", markdown: "正在生成… 💭" }
    });
  });

  it("keeps metadata only in the native title without duplicating it in content", () => {
    expect(materializeFeishuRichText({ title: "🤖 bridge · abcd", markdown: "Answer body" })).toEqual({
      zh_cn: {
        title: "🤖 bridge · abcd",
        content: [
          [{ tag: "md", text: "Answer body" }]
        ]
      }
    });
  });

  it("materializes fenced Bash, TypeScript, and Python as native highlighted code blocks", () => {
    expect(materializeFeishuRichText({
      title: "🤖 bridge · abcd",
      markdown: [
        "Before **code**",
        "```bash",
        "echo hello",
        "```",
        "```typescript",
        "const answer: number = 42;",
        "```",
        "```python",
        "print(42)",
        "```",
        "After code"
      ].join("\n")
    })).toEqual({
      zh_cn: {
        title: "🤖 bridge · abcd",
        content: [
          [{ tag: "md", text: "Before **code**" }],
          [{ tag: "code_block", language: "BASH", text: "echo hello" }],
          [{ tag: "code_block", language: "TYPESCRIPT", text: "const answer: number = 42;" }],
          [{ tag: "code_block", language: "PYTHON", text: "print(42)" }],
          [{ tag: "md", text: "After code" }]
        ]
      }
    });
  });
});
