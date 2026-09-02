import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const builder = "scripts/release/build-private-offline-bundle.sh";
const pinnedHerdr = "/data00/home/feiyu.zhu/.local/bin/herdr";
const pinnedDigest = "3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253";

describe("private offline bundle builder", () => {
  it("requires an explicit original Herdr binary", () => {
    const result = runBuilder(["--validate-only"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--herdr-bin or HERDR_RELEASE_BIN is required");
  });

  it("pins the Linux x64 Herdr release identity without PATH discovery", () => {
    const script = [
      readFileSync(builder, "utf8"),
      readFileSync("scripts/release/lib/bundle-common.sh", "utf8")
    ].join("\n");

    expect(script).toContain('HERDR_RELEASE_VERSION="0.7.5"');
    expect(script).toContain(`HERDR_RELEASE_SHA256="${pinnedDigest}"`);
    expect(script).toContain('RELEASE_PLATFORM="linux-x64"');
    expect(script).not.toMatch(/command -v herdr/);
  });

  it("accepts the pinned executable and reports its normalized identity", () => {
    const result = runBuilder(["--herdr-bin", pinnedHerdr, "--validate-only"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Herdr 0.7.5");
    expect(result.stdout).toContain(pinnedDigest);
    expect(result.stdout).toContain("linux-x64");
  });

  it("rejects a non-ELF executable before creating output", () => {
    const fixture = mkdtempSync(join(tmpdir(), "bundle-invalid-herdr-"));
    const fakeHerdr = join(fixture, "herdr");
    const output = join(fixture, "release");
    writeFileSync(fakeHerdr, "#!/bin/sh\nprintf 'herdr 0.7.5\\n'\n");
    chmodSync(fakeHerdr, 0o755);

    const result = runBuilder(["--herdr-bin", fakeHerdr, "--output-dir", output, "--validate-only"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an ELF executable");
    expect(result.stderr).not.toContain(output);
  });

  it("rejects unknown options without doing work", () => {
    const result = runBuilder(["--herdr-bin", pinnedHerdr, "--surprise"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option: --surprise");
  });

  it("assembles only an allowlisted reproducible runtime and self-verifies it", () => {
    const script = readFileSync(builder, "utf8");

    expect(script).toContain('npm --prefix "$RUNTIME" ci --omit=dev --ignore-scripts');
    expect(script).toContain('for directory_name in test tests __tests__');
    expect(script).toContain('await import("@larksuiteoapi/node-sdk")');
    expect(script).toContain('tar --sort=name --format=gnu --mtime="@$SOURCE_EPOCH" --owner=0 --group=0 --numeric-owner');
    expect(script).toContain('VERIFY_ROOT="$BUILD_TEMP/verify extraction with spaces"');
    expect(script).toContain('"$VERIFY_ROOT/$RELEASE_NAME/scripts/swarmctl" verify');
    expect(script).toContain('bundle_write_manifest "$PAYLOAD"');
    expect(script).not.toMatch(/cps+-Rs+"$REPOSITORY_ROOT"(?:s|$)/);
    for (const excluded of ["src", "tests", ".git", ".env", "bridge.db", "service.log"]) {
      expect(script).not.toContain(`"$PAYLOAD/${excluded}`);
    }
  });
});

describe("private offline bundle verification", () => {
  it("accepts an intact bundle after relocation into a path with spaces", () => {
    const fixture = createBundleFixture("bundle valid with spaces-");
    const result = runSwarmctl(fixture, ["verify"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Bundle verification passed");
  });

  it.each(["changed", "missing", "extra"])("rejects %s payload content", (kind) => {
    const fixture = createBundleFixture(`bundle-${kind}-`);
    if (kind === "changed") writeFileSync(join(fixture, "runtime", "dist", "main.js"), "changed\n");
    if (kind === "missing") rmSync(join(fixture, "templates", "env.example"));
    if (kind === "extra") writeFileSync(join(fixture, "secret.env"), "unexpected\n");

    const result = runSwarmctl(fixture, ["verify"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/manifest|checksum/i);
  });
});

describe("private offline bundle installation", () => {
  it("installs an immutable release and enables two ordered units without starting them", () => {
    const bundle = createBundleFixture("bundle-install-source-");
    const home = mkdtempSync(join(process.cwd(), ".cache", "bundle install home-"));
    const bin = join(home, "bin");
    const calls = join(home, "systemctl.calls");
    mkdirSync(bin);
    const systemctl = join(bin, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SWARM_TEST_SYSTEMCTL_CALLS\"\n");
    chmodSync(systemctl, 0o755);

    const result = runSwarmctl(bundle, ["install"], {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config root"),
      XDG_STATE_HOME: join(home, "state root"),
      SWARM_BUNDLE_SYSTEMD_UNIT_DIR: join(home, "units"),
      SWARM_BUNDLE_SYSTEMCTL: systemctl,
      SWARM_TEST_SYSTEMCTL_CALLS: calls
    });

    expect(result.status, result.stderr).toBe(0);
    const state = join(home, "state root", "herdr-agent-swarm");
    const config = join(home, "config root", "herdr-agent-swarm");
    const current = join(state, "current");
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    const release = readlinkSync(current);
    expect(release).toContain(join(state, "releases", "0.2.0-aaaaaaaaaaaa"));
    expect(statSync(config).mode & 0o777).toBe(0o700);
    expect(statSync(join(config, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(config, "projects.json")).mode & 0o777).toBe(0o600);

    const herdrUnit = readFileSync(join(home, "units", "herdr-headless.service"), "utf8");
    const swarmUnit = readFileSync(join(home, "units", "herdr-agent-swarm.service"), "utf8");
    expect(herdrUnit).toContain(`${release.replaceAll(" ", "\\x20")}/bin/herdr-real server`);
    expect(herdrUnit).not.toContain("HERDR_BIN");
    expect(swarmUnit).toContain("Requires=herdr-headless.service");
    expect(swarmUnit).toContain("After=network-online.target herdr-headless.service");
    expect(swarmUnit).toContain(`${release.replaceAll(" ", "\\x20")}/runtime/dist/main.js`);
    expect(`${herdrUnit}\n${swarmUnit}`).not.toMatch(/@[A-Z_]+@/);

    const invoked = readFileSync(calls, "utf8");
    expect(invoked).toContain("--user enable herdr-headless.service");
    expect(invoked).toContain("--user enable herdr-agent-swarm.service");
    expect(invoked).not.toMatch(/--now| start /);

    writeFileSync(join(config, ".env"), "LARK_APP_SECRET=preserved\n", { mode: 0o600 });
    const second = runSwarmctl(bundle, ["install"], {
      HOME: home, XDG_CONFIG_HOME: join(home, "config root"), XDG_STATE_HOME: join(home, "state root"),
      SWARM_BUNDLE_SYSTEMD_UNIT_DIR: join(home, "units"), SWARM_BUNDLE_SYSTEMCTL: systemctl,
      SWARM_TEST_SYSTEMCTL_CALLS: calls
    });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(join(config, ".env"), "utf8")).toBe("LARK_APP_SECRET=preserved\n");
    expect(readlinkSync(current)).toBe(release);
  });
});

function runBuilder(args: string[]) {
  return spawnSync("/bin/bash", [builder, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HERDR_RELEASE_BIN: "" }
  });
}

function createBundleFixture(prefix: string): string {
  const root = mkdtempSync(join(process.cwd(), ".cache", prefix));
  for (const directory of ["bin", "runtime/dist/cli", "scripts/lib", "templates"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  cpSync(pinnedHerdr, join(root, "bin", "herdr-real"));
  cpSync("scripts/release/swarmctl", join(root, "scripts", "swarmctl"));
  cpSync("scripts/release/lib/bundle-common.sh", join(root, "scripts", "lib", "bundle-common.sh"));
  chmodSync(join(root, "scripts", "swarmctl"), 0o755);
  writeFileSync(join(root, "runtime", "dist", "main.js"), "export {};\n");
  writeFileSync(join(root, "runtime", "dist", "cli", "service-lifecycle.js"), "export {};\n");
  writeFileSync(join(root, "runtime", "package.json"), '{"name":"herdr-agent-swarm","version":"0.2.0","engines":{"node":">=22.12"}}\n');
  writeFileSync(join(root, "runtime", "package-lock.json"), "{}\n");
  cpSync("scripts/release/templates/herdr-headless.service", join(root, "templates", "herdr-headless.service"));
  cpSync("scripts/release/templates/herdr-agent-swarm.service", join(root, "templates", "herdr-agent-swarm.service"));
  cpSync(".env.example", join(root, "templates", "env.example"));
  cpSync("config/projects.example.json", join(root, "templates", "projects.example.json"));
  writeFileSync(join(root, "runtime", "dist", "build-info.json"), `${JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: `sha256:${"b".repeat(64)}`, gitCommit: "a".repeat(40) })}\n`);
  writeFileSync(join(root, "release.json"), `${JSON.stringify({
    product: "herdr-agent-swarm", version: "0.2.0", gitCommit: "a".repeat(40),
    buildId: `sha256:${"b".repeat(64)}`, platform: "linux-x64", node: ">=22.12",
    herdrVersion: "0.7.5", herdrSha256: pinnedDigest, createdAt: "2026-09-02T00:00:00.000Z"
  }, null, 2)}\n`);
  const manifest = spawnSync("/bin/bash", ["-c", '. "$1/scripts/lib/bundle-common.sh"; bundle_write_manifest "$1"', "bundle-manifest", root], { encoding: "utf8" });
  if (manifest.status !== 0) throw new Error(manifest.stderr);
  return root;
}

function runSwarmctl(root: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [join(root, "scripts", "swarmctl"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWARM_BUNDLE_SYSTEMCTL: "true",
      SWARM_BUNDLE_TRAEX: "true",
      ...extraEnvironment
    }
  });
}
