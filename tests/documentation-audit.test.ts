import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditDocumentation } from "../scripts/audit-documentation.mjs";

describe("documentation audit", () => {
  it("accepts current relative file and heading links", () => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), "[Docs](docs/README.md#maintainer-documentation)\n");
    expect(auditDocumentation(root)).toEqual([]);
  });

  it("reports missing files and headings", () => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), "[Missing](docs/nope.md) [Section](docs/README.md#nope)\n");
    expect(auditDocumentation(root)).toEqual(expect.arrayContaining([
      "README.md: linked file is missing: docs/nope.md",
      "README.md: linked heading is missing: docs/README.md#nope"
    ]));
  });

  it("requires every active engineering record in the active index", () => {
    const root = fixture();
    writeFileSync(join(root, "docs/superpowers/specs/unlisted.md"), "# Unlisted\n");
    expect(auditDocumentation(root)).toContain("Active Superpowers record is not indexed: specs/unlisted.md");
  });

  it("rejects stale active-index links after a record is archived", () => {
    const root = fixture();
    writeFileSync(join(root, "docs/superpowers/README.md"), "# Active\n\n[Old](specs/old.md)\n");
    expect(auditDocumentation(root)).toEqual(expect.arrayContaining([
      "docs/superpowers/README.md: linked file is missing: specs/old.md",
      "Superpowers index references a record that is not active: specs/old.md"
    ]));
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "documentation-audit-"));
  for (const path of [
    "docs/domain",
    "docs/superpowers/plans",
    "docs/superpowers/specs",
    "docs/archive/superpowers/specs"
  ]) mkdirSync(join(root, path), { recursive: true });
  const documents: Record<string, string> = {
    "README.md": "# Root\n",
    "docs/README.md": "# Maintainer Documentation\n",
    "docs/architecture.md": "# Architecture\n",
    "docs/architecture-reference.md": "# Reference\n",
    "docs/domain/README.md": "# Domains\n",
    "docs/feishu-group-usage.md": "# Feishu\n",
    "docs/releases.md": "# Releases\n",
    "docs/superpowers/README.md": "# Active\n",
    "docs/superpowers/archive-manifest.json": JSON.stringify({ version: 2, status: "historical", reason: "fixture" }),
    "docs/archive/superpowers/specs/old.md": "# Old\n"
  };
  for (const [path, content] of Object.entries(documents)) writeFileSync(join(root, path), content);
  return root;
}
