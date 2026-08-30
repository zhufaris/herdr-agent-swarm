import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone installer", () => {
  const installScript = readFileSync("install.sh", "utf8");
  const lifecycleScript = readFileSync("scripts/swarm-service.sh", "utf8");
  const productionBuildScript = readFileSync("scripts/stage-production-runtime.sh", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines: { node: string };
    scripts: Record<string, string>;
  };

  it("has no repository-owned compatibility plugin surface", () => {
    expect(existsSync("herdr-plugin.toml")).toBe(false);
    expect(existsSync(".codex-plugin")).toBe(false);
    expect(existsSync("plugin")).toBe(false);
    expect(installScript).not.toContain("herdr plugin");
    expect(installScript).not.toContain("HERDR_PLUGIN_");
    expect(packageJson.scripts).not.toHaveProperty("plugin");
    expect(packageJson.scripts).not.toHaveProperty("swarm:migrate");
  });

  it("rejects obsolete installation flags with migration guidance", () => {
    for (const flag of ["--setup", "--standalone", "--compat-plugin"]) {
      const result = spawnSync("bash", ["install.sh", flag], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Herdr plugin installation has been removed. Run npm run build && npm run swarm:setup, then ./install.sh.");
    }
  });

  it("enforces the shared Node version before installing", () => {
    expect(packageJson.engines.node).toBe(">=22.12");
    expect(installScript).toContain("for command_name in node npm; do");
    expect(installScript).toContain('node "$ROOT/scripts/check-node-version.mjs"');
  });

  it("builds and stages an immutable production release before lifecycle installation", () => {
    const npmInstall = installScript.indexOf("\nnpm ci\n");
    const build = installScript.indexOf("\nnpm run build\n");
    const stage = installScript.indexOf('bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"');
    const lifecycle = installScript.indexOf('dist/cli/service-lifecycle.js" install');

    expect(npmInstall).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(npmInstall);
    expect(stage).toBeGreaterThan(build);
    expect(lifecycle).toBeGreaterThan(stage);
    expect(installScript).toContain('SWARM_RUNTIME_ROOT="$(readlink -f "$STATE_DIR/current")"');
    expect(productionBuildScript).toContain('npm --prefix "$STAGING" ci --omit=dev');
    expect(productionBuildScript).toContain('RELEASE_KEY="$BUILD_ID-$GIT_COMMIT"');
    expect(productionBuildScript).not.toContain('npm --prefix "$ROOT" prune');
  });

  it("guards lifecycle installation until private configuration is complete", () => {
    const staging = installScript.indexOf('bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"');
    const guard = installScript.indexOf("Configuration is missing or still contains placeholders. Run: npm run swarm:setup");
    const lifecycle = installScript.indexOf('dist/cli/service-lifecycle.js" install');

    expect(installScript).toContain('CONFIG_DIR="${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}"');
    expect(installScript).toContain('"$CONFIG_DIR/.env"');
    expect(installScript).toContain('"$CONFIG_DIR/projects.json"');
    for (const placeholder of ["replace-me", "REPLACE_WITH_HERDR_WORKSPACE_ID", "/absolute/path/to/your/project"]) {
      expect(installScript).toContain(placeholder);
    }
    expect(guard).toBeGreaterThan(staging);
    expect(lifecycle).toBeGreaterThan(guard);
    expect(installScript).not.toMatch(/(?:source|\.)\s+["']?\$CONFIG_DIR\/.env/);
    expect(installScript).not.toMatch(/\b(?:cat|sed|awk)\b[^\n]*"\$(?:ENV_FILE|PROJECTS_FILE)"/);
  });

  it("keeps source maps but excludes declarations from production artifacts", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions).toMatchObject({ declaration: false, sourceMap: true });
    expect(packageJson.scripts.start).toBe("node --enable-source-maps dist/main.js");
  });

  it("keeps only the canonical standalone lifecycle path", () => {
    expect(lifecycleScript).not.toContain("migrate)");
    expect(lifecycleScript).not.toContain("swarm-service-cutover");
    expect(lifecycleScript).toContain('dist/cli/service-lifecycle.js" "$ACTION"');
  });

  it("describes the lifecycle result as installed and enabled without claiming startup completed", () => {
    expect(installScript).toContain("Herdr Agent Swarm service installed and enabled.");
    expect(installScript).not.toContain("installed and started");
    expect(installScript).not.toContain("service started");
  });

  it("runs the standalone install lifecycle without starting the service", () => {
    const fixture = mkdtempSync(join(tmpdir(), "standalone-install-"));
    const bin = join(fixture, "bin");
    const config = join(fixture, "config");
    const state = join(fixture, "state");
    const calls = join(fixture, "calls");
    mkdirSync(bin);
    mkdirSync(config);
    writeFileSync(join(config, ".env"), "LARK_APP_SECRET=configured\n");
    writeFileSync(join(config, "projects.json"), "{}\n");
    executable(join(bin, "npm"), "#!/bin/sh\nprintf 'npm %s\\n' \"$*\" >> \"$INSTALL_CALLS\"\n");
    executable(join(bin, "node"), "#!/bin/sh\nprintf 'node %s\\n' \"$*\" >> \"$INSTALL_CALLS\"\n");
    executable(join(bin, "bash"), "#!/bin/sh\nprintf 'bash %s\\n' \"$*\" >> \"$INSTALL_CALLS\"\nmkdir -p \"$SWARM_STATE_DIR\"\nln -sfn \"$INSTALL_RUNTIME_ROOT\" \"$SWARM_STATE_DIR/current\"\n");

    const result = spawnSync("/bin/bash", ["install.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_CALLS: calls, INSTALL_RUNTIME_ROOT: process.cwd(), SWARM_CONFIG_DIR: config, SWARM_STATE_DIR: state }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Herdr Agent Swarm service installed and enabled.");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      `node ${process.cwd()}/scripts/check-node-version.mjs`,
      "npm ci",
      "npm run build",
      `bash ${process.cwd()}/scripts/stage-production-runtime.sh ${state}`,
      `node ${process.cwd()}/dist/cli/service-lifecycle.js install`
    ]);
  });
});

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
