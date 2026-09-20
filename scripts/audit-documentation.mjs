import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditSuperpowersDocs } from "./audit-superpowers-docs.mjs";

const REQUIRED_CURRENT_DOCUMENTS = [
  "README.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/architecture-reference.md",
  "docs/domain/README.md",
  "docs/feishu-group-usage.md",
  "docs/releases.md",
  "docs/superpowers/README.md"
];

export function auditDocumentation(repositoryRoot) {
  const errors = [];
  for (const path of REQUIRED_CURRENT_DOCUMENTS) {
    if (!existsSync(join(repositoryRoot, path))) errors.push(`Required current document is missing: ${path}`);
  }

  const markdownFiles = listCurrentMarkdown(repositoryRoot);
  for (const markdownPath of markdownFiles) {
    const repositoryPath = relative(repositoryRoot, markdownPath);
    const content = readFileSync(markdownPath, "utf8");
    for (const link of markdownLinks(content)) {
      const target = resolveLink(markdownPath, link);
      if (!target) continue;
      const inside = relative(repositoryRoot, target.path);
      if (inside === ".." || inside.startsWith(`..${sep}`)) {
        errors.push(`${repositoryPath}: link escapes the repository: ${link}`);
        continue;
      }
      if (!existsSync(target.path)) {
        errors.push(`${repositoryPath}: linked file is missing: ${link}`);
        continue;
      }
      if (target.fragment && extname(target.path).toLowerCase() === ".md") {
        const headings = markdownHeadingSlugs(readFileSync(target.path, "utf8"));
        if (!headings.has(target.fragment)) errors.push(`${repositoryPath}: linked heading is missing: ${link}`);
      }
    }
  }

  errors.push(...auditActiveSuperpowersIndex(repositoryRoot));
  errors.push(...auditSuperpowersDocs(repositoryRoot));
  return errors;
}

function listCurrentMarkdown(repositoryRoot) {
  const files = [];
  for (const root of [join(repositoryRoot, "README.md"), join(repositoryRoot, "AGENTS.md"), join(repositoryRoot, "docs")]) {
    if (!existsSync(root)) continue;
    if (statSync(root).isFile()) { files.push(root); continue; }
    walk(root, files);
  }
  return files;
}

function walk(root, files) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "archive") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
}

function markdownLinks(content) {
  const links = [];
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of withoutCodeBlocks.matchAll(pattern)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const destination = raw.startsWith("<") ? raw.slice(1, raw.indexOf(">")) : raw.split(/\s+["']/u, 1)[0];
    if (destination) links.push(destination);
  }
  return links;
}

function resolveLink(markdownPath, link) {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(link) || link.startsWith("//")) return null;
  const [encodedPath, encodedFragment] = link.split("#", 2);
  let relativePath;
  let fragment;
  try {
    relativePath = decodeURIComponent(encodedPath ?? "");
    fragment = encodedFragment ? decodeURIComponent(encodedFragment).toLowerCase() : undefined;
  } catch {
    return { path: resolve(dirname(markdownPath), "__invalid_uri__"), fragment: undefined };
  }
  return { path: relativePath ? resolve(dirname(markdownPath), relativePath) : markdownPath, fragment };
}

function markdownHeadingSlugs(content) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(?: {0,3})#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]*>/gu, "")
      .replace(/[`*_~]/gu, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function auditActiveSuperpowersIndex(repositoryRoot) {
  const activeRoot = join(repositoryRoot, "docs/superpowers");
  const indexPath = join(activeRoot, "README.md");
  if (!existsSync(indexPath)) return [];
  const content = readFileSync(indexPath, "utf8");
  const expected = ["plans", "specs"].flatMap((kind) => {
    const root = join(activeRoot, kind);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${kind}/${name}`);
  });
  const errors = expected.filter((path) => !content.includes(`](${path})`)).map((path) => `Active Superpowers record is not indexed: ${path}`);
  const indexed = markdownLinks(content).filter((path) => /^(?:plans|specs)\/[^#]+\.md(?:#.*)?$/u.test(path));
  for (const path of indexed) {
    const filePath = path.split("#", 1)[0];
    if (filePath && !expected.includes(filePath)) errors.push(`Superpowers index references a record that is not active: ${filePath}`);
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const repositoryRoot = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const errors = auditDocumentation(repositoryRoot);
  if (errors.length) { for (const error of errors) console.error(`- ${error}`); process.exitCode = 1; }
  else console.log("Documentation audit passed.");
}
