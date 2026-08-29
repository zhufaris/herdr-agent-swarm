import { describe, expect, it } from "vitest";
import { classifyContinuation } from "../src/domain/continuation-classifier.js";

describe("continuation classifier", () => {
  it.each(["继续", "继续处理", "按这个做", "可以", "确认", "补充：补一条测试", "另外注意: 不要改 API", "再看下日志", "顺便检查类型"])
    ("accepts the conservative phrase %s", (text) => {
      expect(classifyContinuation({ text, hasUnsupportedContent: false })).toEqual({ eligible: true });
    });

  it.each([
    ["/instances", false, "slash_command"],
    ["```ts\nconst x = 1;\n```", false, "code_fence"],
    ["修复另一个登录问题", false, "not_allowlisted"],
    ["继续", true, "unsupported_content"],
    ["继续".repeat(51), false, "too_long"]
  ] as const)("rejects unsafe candidate %s", (text, hasUnsupportedContent, reason) => {
    expect(classifyContinuation({ text, hasUnsupportedContent })).toEqual({ eligible: false, reason });
  });

  it("rejects empty normalized text", () => {
    expect(classifyContinuation({ text: "  ", hasUnsupportedContent: false })).toEqual({ eligible: false, reason: "empty" });
  });
});
