import { pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 12;

export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !supportsNodeVersion(process.versions.node)) {
  process.stderr.write(`Node.js 22.12+ required; found ${process.versions.node}\n`);
  process.exitCode = 1;
}
