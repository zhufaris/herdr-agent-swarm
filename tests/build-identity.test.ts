import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBuildIdentity } from "../src/runtime/build-identity.js";

describe("build identity", () => {
  it("loads strict sanitized build metadata", () => {
    const path = fixture({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:abc123", gitCommit: "0123456789abcdef0123456789abcdef01234567" });
    expect(loadBuildIdentity(path)).toEqual({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:abc123", gitCommit: "0123456789abcdef0123456789abcdef01234567" });
  });

  it("rejects another service and an expected-build mismatch", () => {
    expect(() => loadBuildIdentity(fixture({ serviceId: "other", version: "0.2.0", buildId: "sha256:abc123", gitCommit: null }))).toThrow(/serviceId/);
    const path = fixture({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:abc123", gitCommit: null });
    expect(() => loadBuildIdentity(path, "sha256:different")).toThrow(/does not match expected/);
  });
});

function fixture(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "build-identity-")), "build-info.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
