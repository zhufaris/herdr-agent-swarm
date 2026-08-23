import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = javascriptFiles(dist).sort();
if (files.length === 0) throw new Error("no compiled JavaScript found under dist");
const hash = createHash("sha256").update(`service=herdr-lark-bridge\nversion=${packageJson.version}\n`);
for (const file of files) hash.update(`file=${relative(dist, file)}\n`).update(readFileSync(file));
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const gitCommit = git.status === 0 && /^[a-f0-9]{40}$/.test(git.stdout.trim()) ? git.stdout.trim() : null;
const identity = { serviceId: "herdr-lark-bridge", version: packageJson.version, buildId: `sha256:${hash.digest("hex")}`, gitCommit };
const output = join(dist, "build-info.json");
writeFileSync(output, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o644 });
const { loadBuildIdentity } = await import(pathToFileURL(join(dist, "runtime/build-identity.js")).href);
loadBuildIdentity(output);
process.stdout.write(`generated ${relative(root, output)} (${identity.buildId})\n`);

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}
