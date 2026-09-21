import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProductionDependencyCacheIdentity, detectLibcIdentity } from "../scripts/production-dependency-cache-key.mjs";

describe("production dependency cache identity", () => {
  it("is stable for identical package and runtime inputs", () => {
    const fixture = createFixture();
    const input = { ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime: fakeRuntime() };

    expect(createProductionDependencyCacheIdentity(input)).toEqual(createProductionDependencyCacheIdentity(input));
    expect(createProductionDependencyCacheIdentity(input).values.schemaVersion).toBe("3");
  });

  it.each([
    ["node version", { versions: { node: "24.15.0" } }],
    ["module ABI", { versions: { modules: "138" } }],
    ["N-API", { versions: { napi: "11" } }],
    ["platform", { platform: "darwin" }],
    ["architecture", { arch: "arm64" }],
    ["libc", { libc: "2.39" }]
  ])("changes for a different %s", (_name, change) => {
    const fixture = createFixture();
    const baseline = createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime: fakeRuntime() });
    const runtime = fakeRuntime(change as RuntimeChange);

    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime }).key).not.toBe(baseline.key);
  });

  it("changes for different npm and package manifest inputs", () => {
    const fixture = createFixture();
    const runtime = fakeRuntime();
    const baseline = createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime });

    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.12.0", npmConfigSha256: "a".repeat(64), runtime }).key).not.toBe(baseline.key);
    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "b".repeat(64), runtime }).key).not.toBe(baseline.key);
    writeFileSync(fixture.packagePath, '{"name":"fixture","dependencies":{"x":"1.0.0"}}\n');
    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime }).key).not.toBe(baseline.key);
  });

  it("changes for a different kernel or operating-system release", () => {
    const fixture = createFixture();
    const alternateOsRelease = join(mkdtempSync(join(tmpdir(), "production-dependency-os-")), "os-release");
    writeFileSync(alternateOsRelease, "ID=alternate\n");
    const runtime = fakeRuntime();
    const baseline = createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime, kernelRelease: "kernel-a", osReleasePath: alternateOsRelease });

    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime, kernelRelease: "kernel-b", osReleasePath: alternateOsRelease }).key).not.toBe(baseline.key);
    writeFileSync(alternateOsRelease, "ID=changed\n");
    expect(createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0", npmConfigSha256: "a".repeat(64), runtime, kernelRelease: "kernel-a", osReleasePath: alternateOsRelease }).key).not.toBe(baseline.key);
  });

  it("rejects unsafe identity values before emitting a shell-readable manifest", () => {
    const fixture = createFixture();
    expect(() => createProductionDependencyCacheIdentity({ ...fixture, npmVersion: "11.11.0\ninjected=true", npmConfigSha256: "a".repeat(64), runtime: fakeRuntime() })).toThrow("unsafe value");
  });

  it("fails closed when libc cannot be identified", () => {
    expect(() => detectLibcIdentity({ report: { getReport: () => ({ header: {}, sharedObjects: [] }) } })).toThrow("unable to identify");
  });

  it("fingerprints a non-glibc loader by its path and contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "production-dependency-libc-"));
    const loader = join(directory, "ld-musl-x86_64.so.1");
    writeFileSync(loader, "musl-a");
    const runtime = { report: { getReport: () => ({ header: {}, sharedObjects: [loader] }) } };
    const first = detectLibcIdentity(runtime);
    writeFileSync(loader, "musl-b");

    expect(first).toMatch(/^native-[a-f0-9]{64}$/);
    expect(detectLibcIdentity(runtime)).not.toBe(first);
  });
});

type RuntimeChange = {
  versions?: Partial<{ node: string; modules: string; napi: string }>;
  platform?: NodeJS.Platform;
  arch?: string;
  libc?: string;
};

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "production-dependency-key-"));
  const packageLockPath = join(directory, "package-lock.json");
  const packagePath = join(directory, "package.json");
  writeFileSync(packageLockPath, '{"lockfileVersion":3}\n');
  writeFileSync(packagePath, '{"name":"fixture"}\n');
  return { packageLockPath, packagePath };
}

function fakeRuntime(change: RuntimeChange = {}) {
  const versions = { node: "24.14.1", modules: "137", napi: "10", ...change.versions };
  return {
    versions,
    platform: change.platform ?? "linux",
    arch: change.arch ?? "x64",
    report: { getReport: () => ({ header: { glibcVersionRuntime: change.libc ?? "2.28" }, sharedObjects: [] }) }
  };
}
