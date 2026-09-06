import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_FILES = [
  "dist", "package.json", "package-lock.json", "scripts", "config",
  ".env.example", "README.md", "LICENSE", "docs/architecture.md",
  "docs/architecture-reference.md", "docs/feishu-group-usage.md"
];

export function validateReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) throw new Error(`release tag ${JSON.stringify(tag)} must exactly match package version ${JSON.stringify(expected)}`);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`release tag is not a supported semantic version: ${tag}`);
  return { version, prerelease: version.includes("-") };
}

export function releaseName(version) { return `herdr-agent-swarm-${version}-linux-x64`; }

export function validateBuildIdentity(buildInfo, version, gitCommit) {
  if (buildInfo.version !== version) throw new Error(`compiled build version ${JSON.stringify(buildInfo.version)} does not match package version ${JSON.stringify(version)}`);
  if (!/^[a-f0-9]{40}$/.test(gitCommit) || buildInfo.gitCommit !== gitCommit) throw new Error(`compiled build commit ${JSON.stringify(buildInfo.gitCommit)} does not match current commit ${JSON.stringify(gitCommit)}`);
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if ((key !== "--output" && key !== "--tag") || !value) throw new Error("usage: package-release.mjs --output <directory> --tag <vX.Y.Z>");
    options[key.slice(2)] = value;
  }
  if (!options.output || !options.tag) throw new Error("usage: package-release.mjs --output <directory> --tag <vX.Y.Z>");
  return options;
}

export function packageRelease({ root, output, tag }) {
  const projectRoot = resolve(root);
  const outputDirectory = resolve(output);
  if (outputDirectory === projectRoot || outputDirectory === dirname(projectRoot)) throw new Error(`refusing unsafe release output directory: ${outputDirectory}`);
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const { version, prerelease } = validateReleaseTag(tag, packageJson.version);
  const buildInfoPath = join(projectRoot, "dist/build-info.json");
  if (!existsSync(buildInfoPath)) throw new Error("dist/build-info.json is missing; run npm run build first");
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`cannot resolve current Git commit: ${(git.stderr || git.stdout).trim()}`);
  validateBuildIdentity(buildInfo, version, git.stdout.trim());
  for (const relativePath of RELEASE_FILES) {
    if (!existsSync(join(projectRoot, relativePath))) throw new Error(`required release input is missing: ${relativePath}`);
  }

  mkdirSync(outputDirectory, { recursive: true });
  const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-agent-swarm-release-"));
  const name = releaseName(version);
  const stage = join(temporaryRoot, name);
  mkdirSync(stage);
  try {
    for (const relativePath of RELEASE_FILES) cpSync(join(projectRoot, relativePath), join(stage, relativePath), { recursive: true });
    cpSync(join(projectRoot, "scripts/install-packaged-release.sh"), join(stage, "install.sh"));
    run("npm", ["ci", "--omit=dev"], stage);
    const archive = join(outputDirectory, `${name}.tar.gz`);
    rmSync(archive, { force: true });
    run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", temporaryRoot, name], projectRoot);
    const checksum = join(outputDirectory, "SHA256SUMS");
    writeFileSync(checksum, `${sha256(archive)}  ${basename(archive)}\n`, { mode: 0o644 });
    return { archive, checksum, version, prerelease };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? "signal"}): ${(result.stderr || result.stdout).trim()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = packageRelease({ root: resolve(fileURLToPath(new URL("..", import.meta.url))), output: options.output, tag: options.tag });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
