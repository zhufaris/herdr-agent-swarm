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
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SWARM_ROOT: fixture.root, SWARM_CONFIG_DIR: standaloneConfig, SWARM_STATE_DIR: standaloneState, BRIDGE_SYSTEMD_SERVICE_NAME: "herdr-agent-swarm.service" };

    await expect(runPluginLifecycle("install", environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile=${standaloneConfig}/.env`);
    expect(unit).toContain(`Environment=PROJECTS_CONFIG_PATH=${standaloneConfig}/projects.json`);
    expect(unit).toContain(`Environment=BRIDGE_DATABASE_PATH=${standaloneState}/bridge.db`);
    expect(unit).not.toContain("HERDR_PLUGIN_ROOT");
  });

  it("uses Herdr Agent Swarm standalone defaults", async () => {
    const fixture = createFixture();
    const xdgConfig = join(fixture.root, "xdg-config");
    const xdgState = join(fixture.root, "xdg-state");
    const config = join(xdgConfig, "herdr-agent-swarm");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: fixture.root }] }));
    writeFileSync(join(config, ".env"), ["LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot"].join("\n") + "\n");
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SWARM_ROOT: fixture.root, SWARM_CONFIG_DIR: undefined, SWARM_STATE_DIR: undefined, BRIDGE_SYSTEMD_SERVICE_NAME: undefined, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState };

    await expect(runPluginLifecycle("install", environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain("Description=Herdr Agent Swarm");
    expect(unit).toContain(`EnvironmentFile=${config}/.env`);
    expect(unit).toContain(`Environment=BRIDGE_DATABASE_PATH=${xdgState}/herdr-agent-swarm/bridge.db`);
  });

  it("exposes only canonical swarm lifecycle package commands", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const action of ["init", "install", "start", "status", "restart", "stop", "logs"]) {
      expect(packageJson.scripts[`swarm:${action}`]).toBe(`bash scripts/swarm-service.sh ${action}`);
    }
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith("swarm:"))).toEqual(["swarm:init", "swarm:install", "swarm:start", "swarm:status", "swarm:restart", "swarm:stop", "swarm:logs"]);
    expect(packageJson.scripts).toMatchObject({
      "herdr:traex:install": "bash scripts/install-herdr-traex-shim.sh install",
      "herdr:traex:status": "bash scripts/install-herdr-traex-shim.sh status",
      "herdr:traex:uninstall": "bash scripts/install-herdr-traex-shim.sh uninstall"
    });
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

  it("refuses an unforced restart while the running service reports active turns", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/status") {
        response.end(JSON.stringify({ identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:old-build" }, operational: { prompts: { running: 2, queued: 3 } } }));
        return;
      }
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      writeFileSync(fixture.calls, "");
      await expect(runPluginLifecycle("restart", fixture.environment)).rejects.toThrow(/2 running.*3 queued.*unknown active.*--force/);
      expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active test-bridge.service\n");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses restart when an active worker remains after durable running work clears", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-lark-bridge" }, operational: { prompts: { running: 0, queued: 1 } }, promptWorker: { activeTurnWorkers: 1 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", fixture.environment)).rejects.toThrow(/0 running.*1 queued.*1 active/);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses restart while multi-agent work remains active or uncertain", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-lark-bridge" }, operational: { prompts: { running: 0, queued: 0 } }, promptWorker: { activeTurnWorkers: 0 }, instanceWorker: { activeDispatchWorkers: 0, activeObservers: 1, activeTurns: 1, uncertainTurns: 2 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", fixture.environment)).rejects.toThrow(/instance.*observer.*uncertain.*--force/i);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("uses instance work to block restart even when legacy prompt metrics are absent", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-lark-bridge" }, instanceWorker: { activeDispatchWorkers: 1, activeObservers: 0, activeTurns: 1, uncertainTurns: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", fixture.environment)).rejects.toThrow(/instance work/i);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("allows restart when status is unavailable or belongs to another service", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      statusRequests += 1;
      response.end(JSON.stringify(statusRequests === 1
        ? { status: "ok", identity: { serviceId: "another-service" }, operational: { prompts: { running: 9, queued: 9 } }, promptWorker: { activeTurnWorkers: 9 } }
        : completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user restart --no-block test-bridge.service");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

    const unavailable = createFixture({ port: 1 });
    await runPluginLifecycle("install", unavailable.environment);
    await expect(runPluginLifecycle("restart", { ...unavailable.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "50" })).rejects.toThrow(/did not complete startup/);
    expect(readFileSync(unavailable.calls, "utf8")).toContain("--user restart --no-block test-bridge.service");
  });

  it("rejects force for lifecycle actions other than restart", async () => {
    const fixture = createFixture();
    await expect(runPluginLifecycle("start", fixture.environment, { force: true })).rejects.toThrow(/only for restart/);
  });

  it("allows a forced restart while active turns are reported", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      statusRequests += 1;
      response.end(JSON.stringify(completedStartupStatus({ operational: { prompts: { running: 1, queued: 4 } }, promptWorker: { activeTurnWorkers: 1 } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "1000" }, { force: true })).resolves.toBe(0);
      expect(statusRequests).toBeGreaterThanOrEqual(2);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user restart --no-block test-bridge.service");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("waits for two matching completed startup observations after a non-blocking restart", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      statusRequests += 1;
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(statusRequests).toBeGreaterThanOrEqual(2);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user restart --no-block test-bridge.service");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not accept liveness before startup recovery completes", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/status") {
        response.end(JSON.stringify({
          status: "ok", identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:test-build" },
          startupRecovery: { state: "running" }
        }));
        return;
      }
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-lark-bridge", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/startup running/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["idle", "failed"])("rejects startup recovery state %s", async (state) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ startupRecovery: { state } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(new RegExp(`startup ${state}`));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("resets completed startup observations after an incomplete sample", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      statusRequests += 1;
      const state = statusRequests === 2 ? "running" : "completed";
      response.end(JSON.stringify(completedStartupStatus({ startupRecovery: { state } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "1500" })).resolves.toBe(0);
      expect(statusRequests).toBe(4);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("treats readiness degradation as diagnostic after startup completes", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.statusCode = 503; response.end(JSON.stringify({ status: "not_ready", components: { lark: { ok: false } } })); return; }
      response.end(JSON.stringify(completedStartupStatus()));
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

  it("refreshes the unit identity before starting a rebuilt stopped plugin", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:rebuilt" } })));
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

  it("enables and starts the standalone user service in one operation", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      const environment = {
        ...fixture.environment,
        HERDR_PLUGIN_ROOT: undefined,
        HERDR_PLUGIN_CONFIG_DIR: undefined,
        HERDR_PLUGIN_STATE_DIR: undefined,
        SWARM_ROOT: fixture.root,
        SWARM_CONFIG_DIR: fixture.config,
        SWARM_STATE_DIR: fixture.state,
        BRIDGE_SYSTEMD_SERVICE_NAME: "herdr-agent-swarm.service",
        BRIDGE_PLUGIN_START_TIMEOUT_MS: "1000"
      };
      await runPluginLifecycle("install", environment);
      writeFileSync(fixture.calls, "");
      await expect(runPluginLifecycle("start", environment)).resolves.toBe(0);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user enable --now herdr-agent-swarm.service");
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
      .rejects.toThrow(/did not complete startup with expected build/);
  });

  it("accepts only the expected build identity from the active unit", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus()));
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
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:stale-build" } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("start", { ...fixture.environment, BRIDGE_PLUGIN_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/expected build sha256:test-build.*observed build sha256:stale-build.*startup completed/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports the final active unit and stale build when restart handover times out", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:stale-build" } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runPluginLifecycle("install", fixture.environment);
      await expect(runPluginLifecycle("restart", { ...fixture.environment, BRIDGE_PLUGIN_RESTART_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/restart did not complete startup with expected build sha256:test-build.*unit active.*observed build sha256:stale-build.*startup completed/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function completedStartupStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok", identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:test-build" },
    startupRecovery: { state: "completed" }, ...overrides
  };
}

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
