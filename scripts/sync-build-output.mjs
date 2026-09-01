import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = join(root, "src");
const cacheRoot = join(root, ".cache");
const outputRoot = join(cacheRoot, "ts-build-output");
const buildInfo = join(cacheRoot, "tsconfig.build.tsbuildinfo");
const dist = join(root, "dist");
const action = process.argv[2];

if (dirname(dist) !== root || basename(dist) !== "dist") throw new Error(`Refusing unexpected build output: ${dist}`);
if (action === "prepare") prepare();
else if (action === "publish") publish();
else throw new Error("usage: sync-build-output.mjs <prepare|publish>");

function prepare() {
  mkdirSync(outputRoot, { recursive: true });
  const expected = new Set();
  for (const source of files(sourceRoot)) {
    if (!source.endsWith(".ts") || source.endsWith(".d.ts")) continue;
    const output = relative(sourceRoot, source).replace(/\.ts$/, ".js");
    expected.add(output);
    expected.add(`${output}.map`);
  }
  const missingOutput = [...expected].some((path) => !existsSync(join(outputRoot, path)));
  if (missingOutput) rmSync(buildInfo, { force: true });
  for (const output of files(outputRoot)) {
    if (!expected.has(relative(outputRoot, output))) rmSync(output, { force: true });
  }
}

function publish() {
  rmSync(dist, { recursive: true, force: true });
  cpSync(outputRoot, dist, { recursive: true });
}

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
