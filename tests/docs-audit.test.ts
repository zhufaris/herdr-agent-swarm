import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(entries: Array<Record<string, unknown>>, activeContent = "# Active\n") {
  const root = mkdtempSync(join(tmpdir(), "superpowers-audit-"));
  roots.push(root);
  const manifestPath = join(root, "docs/superpowers/archive-manifest.json");
  const activePath = join(root, "docs/superpowers/plans/active.md");
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(dirname(activePath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ version: 1, entries }));
  writeFileSync(activePath, activeContent);
  return { root, manifestPath };
}

function audit(root: string, manifestPath: string): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, ["scripts/audit-superpowers-docs.mjs", root, manifestPath], { cwd: process.cwd(), encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe("superpowers documentation audit", () => {
  const valid = { source: "docs/superpowers/plans/old.md", destination: "docs/archive/superpowers/plans/old.md", status: "completed", reason: "done" };

  it("accepts a declared archive with no active references", () => {
    const { root, manifestPath } = fixture([valid]);
    const destination = join(root, String(valid.destination));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "# Old\n");
    expect(audit(root, manifestPath)).toEqual({ ok: true, output: "Superpowers documentation archive audit passed.\n" });
  });

  it("reports missing archives, active conflicts, duplicate paths, root escapes, and stale links", () => {
    const escaped = { ...valid, source: "../escape.md", destination: "/tmp/escape.md" };
    const mismatchedSpec = { source: "docs/superpowers/specs/old-design.md", destination: "docs/archive/superpowers/specs/old-design.md", status: "superseded", reason: "replaced" };
    const { root, manifestPath } = fixture([valid, valid, escaped, mismatchedSpec], `See ${valid.source}`);
    const source = join(root, String(valid.source));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "# Old\n");
    const result = audit(root, manifestPath);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Archived source still exists");
    expect(result.output).toContain("Archive destination is missing");
    expect(result.output).toContain("Duplicate archive source");
    expect(result.output).toContain("escapes the repository root");
    expect(result.output).toContain("must stay below docs/archive/superpowers");
    expect(result.output).toContain("links to archived source");
    expect(result.output).toContain("Paired plan/spec status mismatch for old");
  });
});
