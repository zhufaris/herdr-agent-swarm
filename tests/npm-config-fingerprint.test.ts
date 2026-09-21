import { describe, expect, it } from "vitest";
import { fingerprintNpmConfig } from "../scripts/npm-config-fingerprint.mjs";

describe("npm config fingerprint", () => {
  it("ignores prefix-derived paths and key ordering", () => {
    expect(fingerprintNpmConfig({ prefix: "/tmp/a", globalconfig: "/tmp/a/etc/npmrc", registry: "https://registry.example", legacyPeerDeps: false }))
      .toBe(fingerprintNpmConfig({ legacyPeerDeps: false, registry: "https://registry.example", globalconfig: "/tmp/b/etc/npmrc", prefix: "/tmp/b" }));
  });

  it("changes when an effective install setting changes", () => {
    expect(fingerprintNpmConfig({ registry: "https://registry.example", legacyPeerDeps: false }))
      .not.toBe(fingerprintNpmConfig({ registry: "https://registry.example", legacyPeerDeps: true }));
  });
});
