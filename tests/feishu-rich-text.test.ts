import { describe, expect, it } from "vitest";
import { materializeFeishuRichText } from "../src/gateways/feishu/rich-text.js";
import { initialRichTextAnswerPayload } from "../src/domain/rich-text.js";

describe("Feishu rich-text materialization", () => {
  it("wraps canonical Markdown in an ordinary post md element", () => {
    expect(materializeFeishuRichText({ title: "回答（续 2）", markdown: "Hello **world** ▌" })).toEqual({
      zh_cn: {
        title: "回答（续 2）",
        content: [
          [{ tag: "text", text: "回答（续 2）", style: ["bold"] }],
          [{ tag: "md", text: "Hello **world** ▌" }]
        ]
      }
    });
  });

  it("uses an empty title for the first page", () => {
    expect(materializeFeishuRichText({ markdown: "正在生成… ▌" })).toEqual({
      zh_cn: { title: "", content: [[{ tag: "md", text: "正在生成… ▌" }]] }
    });
  });

  it("preserves a metadata title on the initial placeholder reply", () => {
    expect(initialRichTextAnswerPayload(0, 0, "element-1", "🤖 bridge · abcd")).toMatchObject({
      document: { title: "🤖 bridge · abcd", markdown: "正在生成… ▌" }
    });
  });

  it("renders metadata as a visible rich-text heading when thread replies hide native post titles", () => {
    expect(materializeFeishuRichText({ title: "🤖 bridge · abcd", markdown: "Answer body" })).toEqual({
      zh_cn: {
        title: "🤖 bridge · abcd",
        content: [
          [{ tag: "text", text: "🤖 bridge · abcd", style: ["bold"] }],
          [{ tag: "md", text: "Answer body" }]
        ]
      }
    });
  });
});
