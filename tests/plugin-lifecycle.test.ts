import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPluginLifecycle } from "../src/cli/plugin-lifecycle.js";

describe("plugin lifecycle", () => {
  it("supports standalone private config and state paths without Herdr plugin variables", async () => {
    const fixture = createFixture();
    const standaloneConfig = join(fixture.root, "standalone-config");
    const standaloneState = join(fixture.root, "standalone-state");
    mkdirSync(standaloneConfig);
    writeFileSync(join(standaloneConfig, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: fixture.root }] }));
    writeFileSync(join(standaloneConfig, ".env"), ["LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot"].join("\n") + "\n");
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SOLO_AGENT_ROOT: fixture.root, SOLO_AGENT_CONFIG_DIR: standaloneConfig, SOLO_AGENT_STATE_DIR: standaloneState, BRIDGE_SYSTEMD_SERVICE_NAME: "solo-agent.service" };

    await expect(runPluginLifecycle("install", environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "solo-agent.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile=${standaloneConfig}/.env`);
    expect(unit).toContain(`Environment=PROJECTS_CONFIG_PATH=${standaloneConfig}/projects.json`);
    expect(unit).toContain(`Environment=BRIDGE_DATABASE_PATH=${standaloneState}/bridge.db`);
    expect(unit).not.toContain("HERDR_PLUGIN_ROOT");
  });

  it("installs an absolute systemd user unit and delegates lifecycle commands", async () => {
    const fixture = createFixture();
    await expect(runPluginLifecycle("install", fixture.environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "test-bridge.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${fixture.root}`);
    expect(unit).toContain(`EnvironmentFile=${fixture.config}/.env`);
    expect(unit).toContain(`ExecStart=${process.execPath} ${fixture.root}/dist/main.js`);
    expect(unit).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:test-build");
    expect(unit).toContain("Environment=HERDR_SOCKET_PATH=/tmp/test-herdr.sock");
    expect(unit).toContain("Restart=on-failure");
    await expect(runPluginLifecycle("stop", fixture.environment)).resolves.toBe(0);
    expect(readFileSync(fixture.calls, "utf8").trim().split(/\n/)).toEqual([
      "--user daemon-reload", "--user enable test-bridge.service", "--user stop test-bridge.service"
    ]);
  });

  it("preserves config and state while uninstalling only the service", async () => {
    const fixture = createFixture();
    await runPluginLifecycle("install", fixture.environment);
    await expect(runPluginLifecycle("uninstall", fixture.environment)).resolves.toBe(0);
    expect(() => readFileSync(join(fixture.units, "test-bridge.service"))).toThrow();
    expect(readFileSync(join(fixture.config, ".env"), "utf8")).toContain("LARK_APP_ID");
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user disable --now test-bridge.service");
  });

  it("refreshes the unit identity before restarting a rebuilt plugin", async () => {
    const fixture = createFixture();
    await runPluginLifecycle("install", fixture.environment);
    writeFileSync(join(fixture.root, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:rebuilt", gitCommit: null }));
    await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "300" })).rejects.toThrow();
    expect(readFileSync(join(fixture.units, "test-bridge.service"), "utf8")).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:rebuilt");
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user daemon-reload\n--user restart --no-block test-bridge.service");
  });

  it("waits for two matching health observations after a non-blocking restart", async () => {
    let healthRequests = 0;
    const server = createServer((_request, response) => {
      healthRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(healthRequests).toBeGreaterThanOrEqual(2);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user restart --no-block test-bridge.service");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refreshes the unit identity before starting a rebuilt stopped plugin", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:rebuilt" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      writeFileSync(join(fixture.root, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:rebuilt", gitCommit: null }));
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(readFileSync(join(fixture.units, "test-bridge.service"), "utf8")).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:rebuilt");
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user daemon-reload\n--user start test-bridge.service");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refuses service control before installation", async () => {
    const fixture = createFixture();
    await expect(runPluginLifecycle("start", fixture.environment)).rejects.toThrow(/service is not installed/);
  });

  it("does not accept a healthy port unless the managed unit is active", async () => {
    const fixture = createFixture({ active: false });
    await runPluginLifecycle("install", fixture.environment);
    await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "300" }))
      .rejects.toThrow(/did not become active with expected build/);
  });

  it("accepts only the expected build identity from the active unit", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "1000" })).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a healthy response from a stale build", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.1.0", buildId: "sha256:stale-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/expected build sha256:test-build.*observed sha256:stale-build/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports the final active unit and stale build when restart handover times out", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.1.0", buildId: "sha256:stale-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/restart did not become active with expected build sha256:test-build.*unit active.*observed sha256:stale-build/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function createFixture(options: { active?: boolean; port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bridge-plugin-root-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const dist = join(root, "dist");
  const units = join(root, "units");
  const bin = join(root, "bin");
  const calls = join(root, "systemctl.calls");
  for (const directory of [config, state, dist, units, bin]) mkdirSync(directory);
  writeFileSync(join(config, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: root }] }));
  writeFileSync(join(config, ".env"), [
    "LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot",
    `BRIDGE_HTTP_PORT=${options.port ?? 39001}`, "BRIDGE_HTTP_HOST=127.0.0.1"
  ].join("\n") + "\n");
  writeFileSync(join(dist, "main.js"), "// fixture\n");
  writeFileSync(join(dist, "build-info.json"), JSON.stringify({ serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:test-build", gitCommit: null }));
  const active = options.active ?? true;
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\n' "$*" >> ${JSON.stringify(calls)}\nif [ "$2" = "is-active" ]; then ${active ? 'echo active; exit 0' : 'echo inactive; exit 3'}; fi\nexit 0\n`);
  writeFileSync(join(bin, "journalctl"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "journalctl"), 0o755);
  return { root, config, state, units, calls, environment: {
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: state,
    BRIDGE_SYSTEMD_UNIT_DIR: units, BRIDGE_SYSTEMD_SERVICE_NAME: "test-bridge.service", HERDR_SOCKET_PATH: "/tmp/test-herdr.sock"
  } };
}
