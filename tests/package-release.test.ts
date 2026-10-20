import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASE_FILES, parseArguments, releaseName, sha256, validateBuildIdentity, validateReleaseTag } from "../scripts/package-release.mjs";
import packageJson from "../package.json" with { type: "json" };

const version = packageJson.version;

describe("release packaging contract", () => {
  it("accepts only the exact package version tag", () => {
    expect(validateReleaseTag(`v${version}`, version)).toEqual({ version, prerelease: false });
    expect(validateReleaseTag(`v${version}-rc.1`, `${version}-rc.1`)).toEqual({ version: `${version}-rc.1`, prerelease: true });
    expect(() => validateReleaseTag(version, version)).toThrow(/must exactly match/);
    expect(() => validateReleaseTag("v0.3", "0.3")).toThrow(/semantic version/);
  });

  it("requires explicit output and tag arguments", () => {
    expect(parseArguments(["--output", "/tmp/release", "--tag", `v${version}`])).toEqual({ output: "/tmp/release", tag: `v${version}` });
    expect(() => parseArguments(["--output", "/tmp/release"])).toThrow(/usage/);
  });

  it("defines the deployable public file set without runtime state", () => {
    expect(RELEASE_FILES).toContain("dist");
    expect(RELEASE_FILES).toContain("config");
    expect(RELEASE_FILES).toContain("plugins/herdr-choice-list");
    expect(RELEASE_FILES).toContain("docs/agents/group-orchestrator-rollout.md");
    expect(RELEASE_FILES).not.toContain(".env");
    expect(RELEASE_FILES).not.toContain("var");
    expect(releaseName(version)).toBe(`herdr-agent-swarm-${version}-linux-x64`);
  });

  it("rejects stale or version-mismatched compiled output", () => {
    const commit = "a".repeat(40);
    expect(() => validateBuildIdentity({ version, gitCommit: commit }, version, commit)).not.toThrow();
    expect(() => validateBuildIdentity({ version: "0.4.0", gitCommit: commit }, version, commit)).toThrow(/build version/);
    expect(() => validateBuildIdentity({ version, gitCommit: "b".repeat(40) }, version, commit)).toThrow(/build commit/);
  });

  it("computes a standard SHA-256 digest", () => {
    const path = new URL("../LICENSE", import.meta.url);
    expect(sha256(path.pathname)).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });
});
