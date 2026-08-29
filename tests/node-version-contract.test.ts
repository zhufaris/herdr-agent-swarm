import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("Node version contract", () => {
  it("accepts Node 22.12 and later while rejecting older or malformed versions", async () => {
    const { supportsNodeVersion } = await import(pathToFileURL(join(process.cwd(), "scripts/check-node-version.mjs")).href);

    expect(supportsNodeVersion("22.11.99")).toBe(false);
    expect(supportsNodeVersion("22.12.0")).toBe(true);
    expect(supportsNodeVersion("23.0.0")).toBe(true);
    expect(supportsNodeVersion("not-a-version")).toBe(false);
  });
});
