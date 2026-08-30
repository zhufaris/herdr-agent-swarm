import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Herdr plugin manifest", () => {
  const manifest = readFileSync("herdr-plugin.toml", "utf8");
  const setupScript = readFileSync("plugin/setup.sh", "utf8");
  const configureProjectsScript = readFileSync("plugin/configure-projects.sh", "utf8");
  const installScript = readFileSync("install.sh", "utf8");
  const buildScript = readFileSync("plugin/build.sh", "utf8");
  const productionBuildScript = readFileSync("scripts/stage-production-runtime.sh", "utf8");

  it("declares a Linux build without using a startup hook as a service manager", () => {
    expect(manifest).toContain('id = "herdr-lark-bridge"');
    expect(manifest).toContain('platforms = ["linux"]');
    expect(manifest).toContain('command = ["bash", "plugin/build.sh"]');
    expect(manifest).not.toContain("[[startup]]");
  });

  it("keeps the manifest version aligned with the package version", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    expect(manifest).toContain(`version = "${packageVersion}"`);
  });

  it("uses plugin-local lifecycle action ids", () => {
    const actionIds = [...manifest.matchAll(/\[\[actions\]\][\s\S]*?^id = \"([^\"]+)\"/gm)].map((match) => match[1]);
    for (const action of ["setup", "start", "status", "restart", "stop", "logs", "configure-projects", "uninstall-service"]) {
      expect(actionIds.filter((id) => id === action)).toHaveLength(1);
    }
  });

  it("relays state-changing Herdr events without subscribing to focus noise", () => {
    for (const event of ["workspace.closed", "pane.created", "pane.closed", "pane.exited", "pane.output_changed", "pane.agent_detected", "pane.agent_status_changed"]) {
      expect(manifest).toContain(`on = \"${event}\"`);
    }
    expect(manifest).not.toContain('on = "workspace.updated"');
    expect(manifest).not.toContain('on = "tab.created"');
    expect(manifest).not.toContain('on = "tab.closed"');
    expect(manifest).not.toContain('on = "tab.moved"');
    expect(manifest).not.toContain('on = "pane.moved"');
    expect(manifest).not.toContain('on = "pane.updated"');
    expect(manifest).not.toContain('on = "workspace.metadata_updated"');
    expect(manifest).not.toContain('on = "pane.focused"');
    expect(manifest).not.toContain('on = "tab.focused"');
  });

  it("delegates plugin setup to the shared setup CLI", () => {
    expect(setupScript).toContain("dist/cli/setup.js");
    expect(setupScript).toContain('export HERDR_PLUGIN_ROOT="$ROOT"');
    expect(setupScript).toContain('export HERDR_PLUGIN_CONFIG_DIR="$(plugin_config_dir)"');
    expect(setupScript).toContain('export HERDR_PLUGIN_STATE_DIR="$(plugin_state_dir)"');
    expect(setupScript).not.toContain("$EDITOR_COMMAND");
    expect(setupScript).not.toContain('"$SCRIPT_DIR/service.sh"');
  });

  it("keeps configure-projects as the focused legacy registry editor", () => {
    expect(configureProjectsScript).toContain('$ROOT/config/projects.example.json');
    expect(configureProjectsScript).not.toContain('$ROOT/config/projects.json');
  });

  it("keeps installation non-interactive unless setup is requested explicitly", () => {
    expect(installScript).toContain('bash "$ROOT/plugin/build.sh"');
    expect(installScript).toContain('herdr plugin link "$ROOT" --enabled');
    expect(installScript).toContain('if [ "$RUN_SETUP" -eq 1 ]');
    expect(installScript).toContain('herdr plugin action invoke setup --plugin "$PLUGIN_ID"');
  });

  it("requires the Herdr CLI only for plugin installation", () => {
    const standaloneBranch = installScript.indexOf('if [ "$STANDALONE" -eq 1 ]');
    const herdrCheck = installScript.indexOf('command -v herdr');

    expect(installScript).toContain("for command_name in node npm; do");
    expect(standaloneBranch).toBeGreaterThan(0);
    expect(herdrCheck).toBeGreaterThan(standaloneBranch);
  });

  it("enforces the shared Node version contract before either installation path", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string } };
    const versionCheck = 'node "$ROOT/scripts/check-node-version.mjs"';

    expect(packageJson.engines.node).toBe(">=22.12");
    expect(installScript.indexOf(versionCheck)).toBeGreaterThan(installScript.indexOf("for command_name in node npm; do"));
    expect(installScript.indexOf(versionCheck)).toBeLessThan(installScript.indexOf('if [ "$STANDALONE" -eq 1 ]'));
    expect(buildScript).toContain(versionCheck);
    expect(buildScript).not.toContain("node -e");
  });

  it("stages standalone production dependencies without pruning the checkout", () => {
    expect(installScript).toContain('bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"');
    expect(installScript).toContain('SWARM_RUNTIME_ROOT="$(readlink -f "$STATE_DIR/current")"');
    expect(productionBuildScript).toContain('npm --prefix "$STAGING" ci --omit=dev');
    expect(productionBuildScript).toContain('RELEASE_KEY="$BUILD_ID-$GIT_COMMIT"');
    expect(productionBuildScript).not.toContain('npm --prefix "$ROOT" prune');
  });

  it("guards standalone service installation until private configuration is complete", () => {
    const standaloneBranch = installScript.slice(
      installScript.indexOf('if [ "$STANDALONE" -eq 1 ]'),
      installScript.indexOf('if ! command -v herdr')
    );
    const staging = standaloneBranch.indexOf('bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"');
    const guard = standaloneBranch.indexOf('Configuration is missing or still contains placeholders. Run: npm run swarm:setup');
    const lifecycleInstall = standaloneBranch.indexOf('plugin-lifecycle.js" install');

    expect(standaloneBranch).toContain('CONFIG_DIR="${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}"');
    expect(standaloneBranch).toContain('"$CONFIG_DIR/.env"');
    expect(standaloneBranch).toContain('"$CONFIG_DIR/projects.json"');
    for (const placeholder of ["replace-me", "REPLACE_WITH_HERDR_WORKSPACE_ID", "/absolute/path/to/your/project"]) {
      expect(standaloneBranch).toContain(placeholder);
    }
    expect(guard).toBeGreaterThan(staging);
    expect(lifecycleInstall).toBeGreaterThan(guard);
    expect(standaloneBranch).not.toMatch(/(?:source|\.)\s+["']?\$CONFIG_DIR\/.env/);
    expect(standaloneBranch).not.toMatch(/\b(?:cat|sed|awk)\b[^\n]*"\$(?:ENV_FILE|PROJECTS_FILE)"/);
    expect(standaloneBranch).not.toMatch(/^\s*(?:npm run swarm:setup|node .*dist\/cli\/setup\.js)(?:\s|$)/m);
  });

  it("keeps source maps but rejects declaration artifacts in production builds", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions).toMatchObject({ declaration: false, sourceMap: true });
    expect(packageJson.scripts.start).toBe("node --enable-source-maps dist/main.js");
    expect(buildScript).toContain('find "$ROOT/dist" -type f -name');
    expect(buildScript).toContain('*.d.ts');
    expect(buildScript).toContain('*.js.map');
  });
});
