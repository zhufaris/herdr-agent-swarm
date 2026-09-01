import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIVE_ROOT = "docs/superpowers";
const ARCHIVE_ROOT = "docs/archive/superpowers";

export function auditSuperpowersDocs(repositoryRoot, manifestPath = join(repositoryRoot, ACTIVE_ROOT, "archive-manifest.json")) {
  const errors = [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { return [`Cannot read archive manifest: ${error instanceof Error ? error.message : String(error)}`]; }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) return ["Archive manifest must have version 1 and an entries array"];

  const sources = new Set();
  const destinations = new Set();
  const pairedStatuses = new Map();
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `entries[${index}]`;
    if (!entry || typeof entry !== "object") { errors.push(`${label} must be an object`); continue; }
    if (!["completed", "superseded"].includes(entry.status)) errors.push(`${label}.status must be completed or superseded`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) errors.push(`${label}.reason must be non-empty`);
    validateManifestPath(entry.source, ACTIVE_ROOT, `${label}.source`, repositoryRoot, errors);
    validateManifestPath(entry.destination, ARCHIVE_ROOT, `${label}.destination`, repositoryRoot, errors);
    if (typeof entry.source === "string") {
      if (sources.has(entry.source)) errors.push(`Duplicate archive source: ${entry.source}`);
      sources.add(entry.source);
      if (existsSync(join(repositoryRoot, entry.source))) errors.push(`Archived source still exists in active docs: ${entry.source}`);
      const pairKey = basename(entry.source, ".md").replace(/-design$/, "");
      const previousStatus = pairedStatuses.get(pairKey);
      if (previousStatus && previousStatus !== entry.status) errors.push(`Paired plan/spec status mismatch for ${pairKey}`);
      else pairedStatuses.set(pairKey, entry.status);
    }
    if (typeof entry.destination === "string") {
      if (destinations.has(entry.destination)) errors.push(`Duplicate archive destination: ${entry.destination}`);
      destinations.add(entry.destination);
      if (!existsSync(join(repositoryRoot, entry.destination))) errors.push(`Archive destination is missing: ${entry.destination}`);
    }
    if (entry.supersededBy !== undefined) {
      validateRepositoryPath(entry.supersededBy, `${label}.supersededBy`, repositoryRoot, errors);
      if (typeof entry.supersededBy === "string" && !existsSync(join(repositoryRoot, entry.supersededBy))) errors.push(`Superseding document is missing: ${entry.supersededBy}`);
    }
  }

  for (const markdownPath of listMarkdown(join(repositoryRoot, ACTIVE_ROOT))) {
    const content = readFileSync(markdownPath, "utf8");
    for (const source of sources) if (content.includes(source)) errors.push(`Active document ${relative(repositoryRoot, markdownPath)} links to archived source ${source}`);
  }
  return errors;
}

function validateManifestPath(value, prefix, label, repositoryRoot, errors) {
  validateRepositoryPath(value, label, repositoryRoot, errors);
  if (typeof value === "string" && value !== prefix && !value.startsWith(`${prefix}/`)) errors.push(`${label} must stay below ${prefix}`);
}

function validateRepositoryPath(value, label, repositoryRoot, errors) {
  if (typeof value !== "string" || !value || isAbsolute(value)) { errors.push(`${label} must be a relative repository path`); return; }
  const inside = relative(repositoryRoot, resolve(repositoryRoot, value));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) errors.push(`${label} escapes the repository root`);
}

function listMarkdown(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const repositoryRoot = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const errors = auditSuperpowersDocs(repositoryRoot, process.argv[3] ? resolve(process.argv[3]) : undefined);
  if (errors.length) { for (const error of errors) console.error(`- ${error}`); process.exitCode = 1; }
  else console.log("Superpowers documentation archive audit passed.");
}
