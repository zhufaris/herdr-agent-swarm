import { describe, expect, it } from "vitest";
import { materializeFeishuRichText } from "../src/gateways/feishu/rich-text.js";

describe("Feishu rich-text materialization", () => {
  it("wraps canonical Markdown in an ordinary post md element", () => {
    expect(materializeFeishuRichText({ title: "回答（续 2）", markdown: "Hello **world** ▌" })).toEqual({
      zh_cn: {
        title: "回答（续 2）",
        content: [[{ tag: "md", text: "Hello **world** ▌" }]]
      }
    });
  });

  it("uses an empty title for the first page", () => {
    expect(materializeFeishuRichText({ markdown: "正在生成… ▌" })).toEqual({
      zh_cn: { title: "", content: [[{ tag: "md", text: "正在生成… ▌" }]] }
    });
  });
});
