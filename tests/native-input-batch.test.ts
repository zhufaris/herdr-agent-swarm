import { describe, expect, it } from "vitest";
import { formatNativeInputBatch, parseNativeInputBatch } from "../src/domain/native-input-batch.js";

describe("Native Input Batch", () => {
  it("parses a complete canonical batch into its ordered source bodies", () => {
    const bodies = ["first", "second\nline", "third"];
    expect(parseNativeInputBatch(formatNativeInputBatch(bodies))).toEqual(bodies);
  });

  it("leaves partial and malformed envelope lookalikes unparsed", () => {
    expect(parseNativeInputBatch("[Feishu message 1/2]\nfirst")).toBeNull();
    expect(parseNativeInputBatch("prefix [Feishu message 1/1]\nfirst")).toBeNull();
    expect(parseNativeInputBatch("[Feishu message 2/2]\nsecond")).toBeNull();
  });

  it("preserves a user-authored envelope lookalike inside the bridge envelope", () => {
    const literal = "[Feishu message 1/1]\nuser text";
    expect(parseNativeInputBatch(formatNativeInputBatch([literal]))).toEqual([literal]);
  });
});
