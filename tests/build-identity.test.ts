import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBuildIdentity } from "../src/runtime/build-identity.js";

describe("build identity", () => {
  it("hashes compiled files, locked dependencies, and the Node runtime deterministically", async () => {
    const { calculateBuildId } = await import(pathToFileURL(join(process.cwd(), "scripts/build-id-input.mjs")).href);
    const base = {
      serviceId: "herdr-lark-bridge", version: "0.2.0", nodeVersion: "24.1.0", nodeModulesAbi: "137",
      lockfile: Buffer.from("lock-a"), files: [{ path: "main.js", content: Buffer.from("code-a") }]
    };
    const id = calculateBuildId(base);

    expect(id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(calculateBuildId(base)).toBe(id);
    expect(calculateBuildId({ ...base, lockfile: Buffer.from("lock-b") })).not.toBe(id);
    expect(calculateBuildId({ ...base, nodeVersion: "24.2.0" })).not.toBe(id);
    expect(calculateBuildId({ ...base, nodeModulesAbi: "138" })).not.toBe(id);
    expect(calculateBuildId({ ...base, files: [{ path: "main.js", content: Buffer.from("code-b") }] })).not.toBe(id);
  });

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
