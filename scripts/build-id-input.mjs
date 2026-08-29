import { createHash } from "node:crypto";

export function calculateBuildId(input) {
  const hash = createHash("sha256");
  updateField(hash, "service", input.serviceId);
  updateField(hash, "version", input.version);
  updateField(hash, "node", input.nodeVersion);
  updateField(hash, "modules", input.nodeModulesAbi);
  updateField(hash, "lockfile", input.lockfile);
  for (const file of input.files) {
    updateField(hash, "file", file.path);
    updateField(hash, "content", file.content);
  }
  return `sha256:${hash.digest("hex")}`;
}

function updateField(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(`${name}:${bytes.length}:`, "utf8");
  hash.update(bytes);
  hash.update("\n", "utf8");
}
