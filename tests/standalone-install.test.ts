import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  const documentationAuthority = [
    "AGENTS.md",
    "README.md",
    "docs/architecture.md",
    "docs/architecture-reference.md"
  ];

  it("documents only the standalone service operator surface", () => {
    for (const path of documentationAuthority) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/herdr plugin action|--plugin herdr-lark-bridge|herdr-lark-bridge\.service/);
      expect(text, path).not.toMatch(/HERDR_BRIDGE_EVENT_PORT|HERDR_EVENT_DEBOUNCE_MS|\bUDP\b/i);
    }

    expect(readFileSync("AGENTS.md", "utf8")).not.toContain("remains available as a compatibility workflow");

    const readme = readFileSync("README.md", "utf8");
    expect(readme).toMatch(/npm run build\nnpm run swarm:setup\n\.\/install\.sh\nnpm run swarm:start/);
    expect(readme).toContain("decline setup's optional install and start or restart prompts");
    expect(readme).toMatch(/Setup may separately offer to\s+install and then start or restart the service/);
    expect(readme).toContain("Installation enables the unit but deliberately does not start it");
    for (const action of ["start", "status", "restart", "stop", "logs"]) {
      expect(readme).toContain(`npm run swarm:${action}`);
    }
  });

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

  it("retains the active, previous, and a bounded number of production releases", () => {
    const fixture = mkdtempSync(join(tmpdir(), "standalone-retention-"));
    const bin = join(fixture, "bin");
    const state = join(fixture, "state");
    const releases = join(state, "releases");
    mkdirSync(bin);
    mkdirSync(releases, { recursive: true });
    executable(join(bin, "npm"), "#!/bin/sh\nmkdir -p node_modules\n");
    const names = Array.from({ length: 5 }, (_, index) => `${String(index + 1).repeat(64)}-${String(index + 1).repeat(12)}`);
    for (const [index, name] of names.entries()) {
      const path = join(releases, name);
      mkdirSync(path);
      utimesSync(path, index + 1, index + 1);
    }
    symlinkSync(join(releases, names[0]!), join(state, "current"));

    const result = spawnSync("/bin/bash", ["scripts/stage-production-runtime.sh", state], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWARM_RELEASE_RETENTION: "1" }
    });

    expect(result.status, result.stderr).toBe(0);
    const active = result.stdout.trim().split("\n").at(-1)!;
    expect(readdirSync(releases).sort()).toEqual([names[0]!, names[4]!, active.split("/").at(-1)!].sort());
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
    const typecheckConfig = JSON.parse(readFileSync("tsconfig.typecheck.json", "utf8")) as { extends: string; compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions).toMatchObject({
      declaration: false, sourceMap: true, incremental: true,
      outDir: ".cache/ts-build-output", tsBuildInfoFile: ".cache/tsconfig.build.tsbuildinfo"
    });
    expect(typecheckConfig).toMatchObject({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: true, tsBuildInfoFile: ".cache/tsconfig.typecheck.tsbuildinfo" }
    });
    expect(packageJson.scripts.typecheck).toBe("tsc -p tsconfig.typecheck.json");
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain(".cache/");
    expect(packageJson.scripts.build).toContain("sync-build-output.mjs prepare");
    expect(packageJson.scripts.build).toContain("sync-build-output.mjs publish");
    expect(productionBuildScript).toContain('cp -R "$ROOT/dist" "$STAGING/dist"');
    expect(productionBuildScript).not.toContain('.cache');
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
