import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "src");
const files = walk(sourceRoot).filter((file) => file.endsWith(".ts"));
const violations = [];

for (const file of files) {
  const importer = relative(root, file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imported = resolveImport(file, statement.moduleSpecifier.text);
    if (!imported) continue;
    const target = relative(root, imported);
    if (target === "src/store/sqlite/capability-graph.ts" && importer !== "src/store/sqlite-store-bundle.ts") {
      violations.push(`${importer} may not bypass the SQLite bundle to import ${target}`);
    }
    if (importer.startsWith("src/store/sqlite/") && /^(src\/(?:adapters|cards|composition|coordinator|events)\/|src\/main\.ts$)/.test(target)) {
      violations.push(`${importer} may not depend outward on ${target}`);
    }
    if (!importer.startsWith("src/composition/") && importer !== "src/main.ts" && target.startsWith("src/composition/")) {
      violations.push(`${importer} may not depend on the composition layer ${target}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture import violations:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture imports valid (${files.length} source files checked).\n`);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
  return candidate.startsWith(sourceRoot) ? candidate : null;
}
