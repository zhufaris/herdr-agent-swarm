import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PREFIX_DERIVED_KEYS = new Set(["globalconfig", "prefix"]);

export function fingerprintNpmConfig(value) {
  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PREFIX_DERIVED_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${fingerprintNpmConfig(JSON.parse(readFileSync(0, "utf8")))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
