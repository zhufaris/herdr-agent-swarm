import { describe, expect, it } from "vitest";
import { outputFingerprint } from "../src/runtime/output.js";

describe("terminal output", () => {
  it("produces stable content fingerprints", () => {
    expect(outputFingerprint("same")).toBe(outputFingerprint("same"));
    expect(outputFingerprint("same")).not.toBe(outputFingerprint("different"));
  });
});
