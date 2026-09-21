import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { pathToFileURL } from "node:url";

const SAFE_VALUE = /^[A-Za-z0-9._-]+$/;

export function createProductionDependencyCacheIdentity({
  packageLockPath, packagePath, npmVersion, npmConfigSha256, runtime = process,
  kernelRelease = release(), osReleasePath = "/etc/os-release",
  libcIdentity = detectLibcIdentity(runtime)
}) {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const fileHash = (path) => hash(readFileSync(path));
  const values = {
    schemaVersion: "3",
    lockSha256: fileHash(packageLockPath),
    packageSha256: fileHash(packagePath),
    nodeVersion: runtime.versions.node,
    nodeModules: runtime.versions.modules ?? "none",
    nodeNapi: runtime.versions.napi ?? "none",
    platform: runtime.platform,
    arch: runtime.arch,
    kernelRelease,
    osReleaseSha256: existsSync(osReleasePath) ? fileHash(osReleasePath) : "none",
    libc: libcIdentity,
    npmVersion,
    npmConfigSha256
  };
  if (Object.values(values).some((value) => !SAFE_VALUE.test(value))) {
    throw new Error("production dependency cache identity contains an unsafe value");
  }
  return { key: hash(JSON.stringify(values)), values };
}

export function detectLibcIdentity(runtime = process) {
  const report = runtime.report?.getReport();
  const glibcVersion = report?.header?.glibcVersionRuntime;
  if (glibcVersion) return `glibc-${glibcVersion}`;
  const sharedObjects = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
  const libcObjects = sharedObjects
    .filter((path) => /(?:^|\/)(?:libc\.so(?:\.|$)|ld-musl-[^/]+\.so(?:\.|$))/.test(path))
    .sort();
  if (libcObjects.length === 0) throw new Error("unable to identify the runtime libc");
  const digest = createHash("sha256");
  for (const path of libcObjects) {
    digest.update(path);
    digest.update(readFileSync(path));
  }
  return `native-${digest.digest("hex")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [packageLockPath, packagePath, npmVersion, npmConfigSha256] = process.argv.slice(2);
    if (!packageLockPath || !packagePath || !npmVersion || !npmConfigSha256) throw new Error("usage: production-dependency-cache-key.mjs <package-lock> <package> <npm-version> <npm-config-sha256>");
    const identity = createProductionDependencyCacheIdentity({ packageLockPath, packagePath, npmVersion, npmConfigSha256 });
    process.stdout.write(`${identity.key}\n`);
    for (const [name, value] of Object.entries(identity.values)) process.stdout.write(`${name}=${value}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
