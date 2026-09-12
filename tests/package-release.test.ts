import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASE_FILES, parseArguments, releaseName, sha256, validateBuildIdentity, validateReleaseTag } from "../scripts/package-release.mjs";

describe("release packaging contract", () => {
  it("accepts only the exact package version tag", () => {
    expect(validateReleaseTag("v0.4.0", "0.4.0")).toEqual({ version: "0.4.0", prerelease: false });
    expect(validateReleaseTag("v0.4.0-rc.1", "0.4.0-rc.1")).toEqual({ version: "0.4.0-rc.1", prerelease: true });
    expect(() => validateReleaseTag("0.4.0", "0.4.0")).toThrow(/must exactly match/);
    expect(() => validateReleaseTag("v0.3", "0.3")).toThrow(/semantic version/);
  });

  it("requires explicit output and tag arguments", () => {
    expect(parseArguments(["--output", "/tmp/release", "--tag", "v0.4.0"])).toEqual({ output: "/tmp/release", tag: "v0.4.0" });
    expect(() => parseArguments(["--output", "/tmp/release"])).toThrow(/usage/);
  });

  it("defines the deployable public file set without runtime state", () => {
    expect(RELEASE_FILES).toContain("dist");
    expect(RELEASE_FILES).toContain("config");
    expect(RELEASE_FILES).not.toContain(".env");
    expect(RELEASE_FILES).not.toContain("var");
    expect(releaseName("0.4.0")).toBe("herdr-agent-swarm-0.4.0-linux-x64");
  });

  it("rejects stale or version-mismatched compiled output", () => {
    const commit = "a".repeat(40);
    expect(() => validateBuildIdentity({ version: "0.4.0", gitCommit: commit }, "0.4.0", commit)).not.toThrow();
    expect(() => validateBuildIdentity({ version: "0.3.0", gitCommit: commit }, "0.4.0", commit)).toThrow(/build version/);
    expect(() => validateBuildIdentity({ version: "0.4.0", gitCommit: "b".repeat(40) }, "0.4.0", commit)).toThrow(/build commit/);
  });

  it("computes a standard SHA-256 digest", () => {
    const path = new URL("../LICENSE", import.meta.url);
    expect(sha256(path.pathname)).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });
});
