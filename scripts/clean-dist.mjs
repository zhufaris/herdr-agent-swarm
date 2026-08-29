import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(process.argv[2] ?? scriptRoot);
const dist = resolve(join(root, "dist"));

if (dirname(dist) !== root || basename(dist) !== "dist") {
  throw new Error(`Refusing to clean unexpected build output: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
