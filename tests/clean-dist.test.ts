import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("clean dist", () => {
  it("removes only the repository-local dist directory and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "clean-dist-"));
    fixtures.push(root);
    mkdirSync(join(root, "dist", "nested"), { recursive: true });
    writeFileSync(join(root, "dist", "nested", "stale.js"), "stale");
    writeFileSync(join(root, "sentinel.txt"), "keep");

    const first = spawnSync(process.execPath, [join(process.cwd(), "scripts/clean-dist.mjs"), root], { encoding: "utf8" });
    expect(first).toMatchObject({ status: 0, stderr: "" });
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(existsSync(join(root, "sentinel.txt"))).toBe(true);

    const second = spawnSync(process.execPath, [join(process.cwd(), "scripts/clean-dist.mjs"), root], { encoding: "utf8" });
    expect(second).toMatchObject({ status: 0, stderr: "" });
    expect(existsSync(join(root, "sentinel.txt"))).toBe(true);
  });
});
