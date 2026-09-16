import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTENT_PATTERNS = [
  ["GitHub token", /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["personal workspace path", new RegExp("/data00/" + "home/")],
  ["maintainer home path", new RegExp("/home/" + "feiyu\\.zhu(?:/|\\b)")],
  ["private organization email", new RegExp("@byte" + "dance\\.com\\b", "i")],
  ["TRAE CLI co-author trailer", new RegExp("Co-authored-by:\\s*TRAE " + "CLI\\b", "i")],
  ["obsolete license identity", new RegExp("herdr-lark-" + "bridge contributors", "i")],
];
const RUNTIME_PATH = /(?:^|\/)(?:\.env$|var\/|release\/)|\.(?:db|sqlite|sqlite3|pem|key|log)$/i;

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

export function auditPublicRelease(root) {
  const repositoryRoot = resolve(root);
  const errors = [];
  const tracked = git(repositoryRoot, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of tracked) {
    if (RUNTIME_PATH.test(path)) errors.push("Tracked runtime or private file: " + path);
    let content;
    try { content = readFileSync(resolve(repositoryRoot, path), "utf8"); }
    catch { continue; }
    for (const [label, pattern] of CONTENT_PATTERNS) {
      if (pattern.test(content)) errors.push(label + " in " + path);
    }
  }
  const refs = git(repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/backup", "refs/original", "refs/replace"])
    .split("\n").filter(Boolean);
  for (const ref of refs) errors.push("Unexpected local history ref: " + ref);
  return [...new Set(errors)].sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  const errors = auditPublicRelease(root);
  if (errors.length) {
    for (const error of errors) console.error("- " + error);
    process.exitCode = 1;
  } else {
    console.log("Public release audit passed for " + (relative(process.cwd(), root) || ".") + ".");
  }
}
