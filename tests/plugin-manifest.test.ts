import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Herdr plugin manifest", () => {
  const manifest = readFileSync("herdr-plugin.toml", "utf8");
  const setupScript = readFileSync("plugin/setup.sh", "utf8");
  const installScript = readFileSync("install.sh", "utf8");

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
    for (const event of ["workspace.closed", "pane.created", "pane.closed", "pane.exited", "pane.agent_detected", "pane.agent_status_changed"]) {
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

  it("restarts after setup so an already-running service loads the new configuration", () => {
    expect(setupScript).toContain('"$SCRIPT_DIR/service.sh" install');
    expect(setupScript).toContain('"$SCRIPT_DIR/service.sh" restart');
    expect(setupScript).not.toContain('"$SCRIPT_DIR/service.sh" start\n');
  });

  it("keeps installation non-interactive unless setup is requested explicitly", () => {
    expect(installScript).toContain('bash "$ROOT/plugin/build.sh"');
    expect(installScript).toContain('herdr plugin link "$ROOT" --enabled');
    expect(installScript).toContain('if [ "$RUN_SETUP" -eq 1 ]');
    expect(installScript).toContain('herdr plugin action invoke setup --plugin "$PLUGIN_ID"');
  });
});
