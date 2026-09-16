import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "public-release-audit-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  return root;
}

function audit(root: string) {
  return spawnSync(process.execPath, ["scripts/audit-public-release.mjs", root], { cwd: process.cwd(), encoding: "utf8" });
}

describe("public release audit", () => {
  it("accepts a sanitized public tree", () => {
    const result = audit(repository({ "README.md": "# Public\n", ".env.example": "LARK_APP_SECRET=replace-me\n" }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public release audit passed");
  });

  it("rejects internal paths, co-author text, credentials, and runtime files", () => {
    const personalPath = "/data00/" + "home/user/project";
    const coAuthor = "Co-authored-by: TRAE " + "CLI <bot@example.com>";
    const token = "ghp_" + "abcdefghijklmnopqrstuvwxyz123456";
    const root = repository({
      "README.md": [personalPath, coAuthor, token, ""].join("\n"),
      "var/bridge.db": "runtime",
    });
    const result = audit(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("personal workspace path");
    expect(result.stderr).toContain("TRAE CLI co-author trailer");
    expect(result.stderr).toContain("GitHub token");
    expect(result.stderr).toContain("Tracked runtime or private file");
  });

  it("rejects the retired license identity", () => {
    const retiredIdentity = "herdr-lark-" + "bridge contributors";
    const result = audit(repository({ "LICENSE": "Copyright (c) 2026 " + retiredIdentity + "\n" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("obsolete license identity");
  });

  it("rejects backup history refs", () => {
    const root = repository({ "README.md": "# Public\n" });
    const tree = execFileSync("git", ["-C", root, "mktree"], { input: "", encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["-C", root, "commit-tree", tree, "-m", "backup"], {
      encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
    }).trim();
    execFileSync("git", ["-C", root, "update-ref", "refs/backup/pre-release/main", commit]);
    const result = audit(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected local history ref");
  });
});
