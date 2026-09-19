import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, renameSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createUnixServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupLifecycleAdapter, inspectServiceLifecycle, isServiceLifecycleEntrypoint, parseLogQueryArgs, resolveUserSystemdFallbackEnvironment, runServiceLifecycle, validatePrivateLogMetadata } from "../src/cli/service-lifecycle.js";

describe("service lifecycle", () => {
  it("recognizes a CLI entrypoint reached through a symlinked home path", () => {
    const fixture = mkdtempSync(join(tmpdir(), "service-entrypoint-"));
    const real = join(fixture, "real.js");
    const alias = join(fixture, "alias.js");
    writeFileSync(real, "// entrypoint\n");
    symlinkSync(real, alias);
    expect(isServiceLifecycleEntrypoint(new URL(`file://${real}`).href, alias)).toBe(true);
    expect(isServiceLifecycleEntrypoint(new URL(`file://${real}`).href, join(fixture, "missing.js"))).toBe(false);
  });

  it("activates a release only after installing and enabling its unit", async () => {
    const fixture = createActivationFixture();

    await expect(runServiceLifecycle("install", fixture.environment)).resolves.toBe(0);

    expect(realpathSync(fixture.current)).toBe(fixture.candidate);
    expect(readFileSync(fixture.unit, "utf8")).toContain(`WorkingDirectory=${fixture.candidate}`);
    expect(existsSync(fixture.marker)).toBe(false);
    expect(readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual([
      "--user is-active herdr-agent-swarm.service",
      "--user daemon-reload",
      "--user enable herdr-agent-swarm.service"
    ]);
  });

  it("prunes only after activation while retaining current, previous, and configured inactive releases", async () => {
    const fixture = createActivationFixture({ previous: true });
    const releases = join(fixture.state, "releases");
    const inactive = Array.from({ length: 3 }, (_, index) => join(releases, `${String(index + 1).repeat(64)}-${String(index + 1).repeat(12)}`));
    for (const [index, path] of inactive.entries()) { mkdirSync(path); const time = new Date(index + 1); utimesSync(path, time, time); }

    await expect(runServiceLifecycle("install", { ...fixture.environment, SWARM_RELEASE_RETENTION: "1" })).resolves.toBe(0);

    expect(existsSync(fixture.candidate)).toBe(true);
    expect(existsSync(fixture.previous)).toBe(true);
    expect(inactive.filter(existsSync)).toHaveLength(1);
  });

  it("retains the release referenced by the installed unit while another candidate is current", async () => {
    const fixture = createActivationFixture({ previous: true });
    const releases = join(fixture.state, "releases");
    const running = join(releases, `${"e".repeat(64)}-${"f".repeat(12)}`);
    const inactive = join(releases, `${"1".repeat(64)}-${"2".repeat(12)}`);
    mkdirSync(running);
    mkdirSync(inactive);
    writeFileSync(fixture.unit, `[Service]\nWorkingDirectory=${running}\n`, { mode: 0o640 });

    await expect(runServiceLifecycle("install", { ...fixture.environment, SWARM_RELEASE_RETENTION: "0" })).resolves.toBe(0);

    expect(existsSync(fixture.candidate)).toBe(true);
    expect(existsSync(fixture.previous)).toBe(true);
    expect(existsSync(running)).toBe(true);
    expect(existsSync(inactive)).toBe(false);
  });

  it("restores the previous unit and current release when daemon reload fails", async () => {
    const fixture = createActivationFixture({ previous: true, failFirstReload: true, priorEnabled: "enabled" });
    const priorUnit = readFileSync(fixture.unit, "utf8");
    const rotationUnit = join(fixture.units, "herdr-agent-swarm-log-rotate.service");
    const rotationTimer = join(fixture.units, "herdr-agent-swarm-log-rotate.timer");
    writeFileSync(rotationUnit, "previous rotation service\n", { mode: 0o640 });
    writeFileSync(rotationTimer, "previous rotation timer\n", { mode: 0o640 });

    await expect(runServiceLifecycle("install", fixture.environment)).resolves.toBe(7);

    expect(realpathSync(fixture.current)).toBe(fixture.previous);
    expect(readFileSync(fixture.unit, "utf8")).toBe(priorUnit);
    expect(readFileSync(rotationUnit, "utf8")).toBe("previous rotation service\n");
    expect(readFileSync(rotationTimer, "utf8")).toBe("previous rotation timer\n");
    expect(existsSync(fixture.marker)).toBe(false);
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user enable herdr-agent-swarm.service\n");
  });

  it("removes a new unit and leaves current absent when first-install activation fails", async () => {
    const fixture = createActivationFixture({ failEnable: true });

    await expect(runServiceLifecycle("install", fixture.environment)).resolves.toBe(8);

    expect(existsSync(fixture.current)).toBe(false);
    expect(existsSync(fixture.unit)).toBe(false);
    expect(existsSync(join(fixture.units, "herdr-agent-swarm-log-rotate.service"))).toBe(false);
    expect(existsSync(join(fixture.units, "herdr-agent-swarm-log-rotate.timer"))).toBe(false);
    expect(existsSync(fixture.marker)).toBe(false);
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user disable herdr-agent-swarm.service\n");
  });

  it("restores a previously disabled unit when enable fails", async () => {
    const fixture = createActivationFixture({ previous: true, failEnable: true, priorEnabled: "disabled" });
    const priorUnit = readFileSync(fixture.unit, "utf8");

    await expect(runServiceLifecycle("install", fixture.environment)).resolves.toBe(8);

    expect(realpathSync(fixture.current)).toBe(fixture.previous);
    expect(readFileSync(fixture.unit, "utf8")).toBe(priorUnit);
    expect(statSync(fixture.unit).mode & 0o777).toBe(0o640);
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user disable herdr-agent-swarm.service\n");
    expect(existsSync(fixture.marker)).toBe(false);
  });

  it("compensates when the final current-link commit fails", async () => {
    const fixture = createActivationFixture({ previous: true, priorEnabled: "enabled" });
    const priorUnit = readFileSync(fixture.unit, "utf8");
    let attempts = 0;

    await expect(runServiceLifecycle("install", fixture.environment, {
      renameActivationLink(source, destination) {
        if (attempts++ === 0) throw new Error("injected current commit failure");
        return renameSync(source, destination);
      }
    })).rejects.toThrow("injected current commit failure");

    expect(realpathSync(fixture.current)).toBe(fixture.previous);
    expect(readFileSync(fixture.unit, "utf8")).toBe(priorUnit);
    expect(existsSync(fixture.marker)).toBe(false);
  });

  it("retains a recovery marker and blocks mutation when compensation fails", async () => {
    const fixture = createActivationFixture({ previous: true, failEveryReload: true, priorEnabled: "enabled" });

    await expect(runServiceLifecycle("install", fixture.environment)).rejects.toThrow(/rollback failed.*recovery marker retained/);
    expect(existsSync(fixture.marker)).toBe(true);
    await expect(runServiceLifecycle("start", fixture.environment)).rejects.toThrow(/incomplete release activation/);
  });

  it("restores a same-user systemd session bus only when the environment omits both session variables", async () => {
    const runtimeBase = mkdtempSync(join(tmpdir(), "agent-swarm-runtime-"));
    const uid = process.getuid!();
    const runtimeDirectory = join(runtimeBase, String(uid));
    mkdirSync(runtimeDirectory);
    const busPath = join(runtimeDirectory, "bus");
    const bus = createUnixServer();
    await new Promise<void>((resolve) => bus.listen(busPath, resolve));
    try {
      expect(resolveUserSystemdFallbackEnvironment({ PATH: process.env.PATH }, runtimeBase, uid)).toMatchObject({
        XDG_RUNTIME_DIR: runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`
      });
      expect(resolveUserSystemdFallbackEnvironment({ XDG_RUNTIME_DIR: "/untrusted" }, runtimeBase, uid)).toBeNull();
      expect(resolveUserSystemdFallbackEnvironment({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/untrusted/bus" }, runtimeBase, uid)).toBeNull();
    } finally { await new Promise<void>((resolve, reject) => bus.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses systemd fallback when the expected session bus is absent", () => {
    const runtimeBase = mkdtempSync(join(tmpdir(), "agent-swarm-runtime-"));
    expect(resolveUserSystemdFallbackEnvironment({}, runtimeBase, process.getuid!())).toBeNull();
  });

  it("inspects installation and activity without mutating lifecycle state", async () => {
    const fixture = createFixture();

    await expect(inspectServiceLifecycle(fixture.environment)).resolves.toMatchObject({
      installed: false, active: true, summary: expect.stringContaining("herdr-agent-swarm.service")
    });
    expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
  });

  it("does not allow an environment override to retarget lifecycle operations", async () => {
    const fixture = createFixture();

    await runServiceLifecycle("install", { ...fixture.environment, BRIDGE_SYSTEMD_SERVICE_NAME: "alternate.service" });

    expect(readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8")).toContain("Description=Herdr Agent Swarm");
    expect(() => readFileSync(join(fixture.units, "alternate.service"), "utf8")).toThrow();
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user enable herdr-agent-swarm.service");
  });

  it("rejects compatibility plugin variables as lifecycle context", async () => {
    const fixture = createFixture();
    const environment = {
      ...fixture.environment,
      SWARM_ROOT: undefined,
      SWARM_CONFIG_DIR: undefined,
      SWARM_STATE_DIR: undefined,
      HERDR_PLUGIN_ROOT: fixture.root,
      HERDR_PLUGIN_CONFIG_DIR: fixture.config,
      HERDR_PLUGIN_STATE_DIR: fixture.state
    };

    await expect(runServiceLifecycle("install", environment)).rejects.toThrow(/SWARM_ROOT is required/);
  });

  it("adapts setup lifecycle operations and rejects non-zero results", async () => {
    const fixture = createFixture();
    const lifecycle = createSetupLifecycleAdapter(fixture.environment);

    await lifecycle.install({} as never);
    await expect(lifecycle.inspect({} as never)).resolves.toMatchObject({ installed: true, active: true });
  });
  it("supports standalone private config and state paths without Herdr plugin variables", async () => {
    const fixture = createFixture();
    const standaloneConfig = join(fixture.root, "standalone-config");
    const standaloneState = join(fixture.root, "standalone-state");
    mkdirSync(standaloneConfig);
    writeFileSync(join(standaloneConfig, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: fixture.root }] }));
    writeFileSync(join(standaloneConfig, ".env"), ["LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot", "LARK_ALLOWED_OPEN_IDS=ou_user", "LARK_ADMIN_OPEN_IDS=ou_user"].join("\n") + "\n");
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SWARM_ROOT: fixture.root, SWARM_CONFIG_DIR: standaloneConfig, SWARM_STATE_DIR: standaloneState };

    await expect(runServiceLifecycle("install", environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile=${standaloneConfig}/.env`);
    expect(unit).toContain(`Environment=PROJECTS_CONFIG_PATH=${standaloneConfig}/projects.json`);
    expect(unit).toContain(`Environment=RUNTIME_CONFIG_PATH=${standaloneConfig}/runtime.yaml`);
    expect(unit).toContain(`Environment=BRIDGE_DATABASE_PATH=${standaloneState}/bridge.db`);
    expect(unit).not.toContain("HERDR_PLUGIN_ROOT");
  });

  it("preserves an explicit standalone database path in the rendered unit", async () => {
    const fixture = createFixture();
    const standaloneConfig = join(fixture.root, "standalone-config");
    const standaloneState = join(fixture.root, "standalone-state");
    const legacyDatabase = join(fixture.root, "legacy", "bridge.db");
    mkdirSync(standaloneConfig);
    mkdirSync(join(fixture.root, "legacy"));
    writeFileSync(legacyDatabase, "fixture");
    writeFileSync(join(standaloneConfig, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: fixture.root }] }));
    writeFileSync(join(standaloneConfig, ".env"), ["LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot", "LARK_ALLOWED_OPEN_IDS=ou_user", "LARK_ADMIN_OPEN_IDS=ou_user", "BRIDGE_DATABASE_PATH=" + legacyDatabase].join("\n") + "\n");
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SWARM_ROOT: fixture.root, SWARM_CONFIG_DIR: standaloneConfig, SWARM_STATE_DIR: standaloneState };

    await runServiceLifecycle("install", environment);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain("Environment=BRIDGE_DATABASE_PATH=" + legacyDatabase);
    expect(unit).not.toContain("Environment=BRIDGE_DATABASE_PATH=" + standaloneState + "/bridge.db");
  });

  it("uses Herdr Agent Swarm standalone defaults", async () => {
    const fixture = createFixture();
    const xdgConfig = join(fixture.root, "xdg-config");
    const xdgState = join(fixture.root, "xdg-state");
    const config = join(xdgConfig, "herdr-agent-swarm");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: fixture.root }] }));
    writeFileSync(join(config, ".env"), ["LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot", "LARK_ALLOWED_OPEN_IDS=ou_user", "LARK_ADMIN_OPEN_IDS=ou_user"].join("\n") + "\n");
    const environment = { ...fixture.environment, HERDR_PLUGIN_ROOT: undefined, HERDR_PLUGIN_CONFIG_DIR: undefined, HERDR_PLUGIN_STATE_DIR: undefined, SWARM_ROOT: fixture.root, SWARM_CONFIG_DIR: undefined, SWARM_STATE_DIR: undefined, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState };

    await expect(runServiceLifecycle("install", environment)).resolves.toBe(0);
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
    expect(packageJson.scripts).not.toHaveProperty("swarm:migrate");
    expect(packageJson.scripts["swarm:setup"]).toBe("node dist/cli/setup.js");
    expect(packageJson.scripts["swarm:doctor"]).toBe("node dist/cli/doctor.js");
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith("swarm:"))).toEqual(["swarm:init", "swarm:setup", "swarm:doctor", "swarm:install", "swarm:start", "swarm:status", "swarm:restart", "swarm:stop", "swarm:logs"]);
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith("herdr:traex:"))).toBe(false);
    const script = readFileSync(join(process.cwd(), "scripts/swarm-service.sh"), "utf8");
    expect(script).not.toContain("migrate)");
    expect(script).not.toContain("swarm-service-cutover");
    expect(script).toContain('setup) exec node "$ROOT/dist/cli/setup.js"');
    expect(script).toContain('doctor) exec node "$ROOT/dist/cli/doctor.js"');
    expect(script).toContain('exec node "$ROOT/dist/cli/service-lifecycle.js" "$ACTION" "${@:2}"');
    expect(packageJson.scripts.service).toBe("node dist/cli/service-lifecycle.js");
    expect(packageJson.scripts.plugin).toBeUndefined();
  });

  it("installs an absolute systemd user unit and delegates lifecycle commands", async () => {
    const fixture = createFixture();
    await expect(runServiceLifecycle("install", fixture.environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${fixture.root}`);
    expect(unit).toContain(`EnvironmentFile=${fixture.config}/.env`);
    expect(unit).toContain(`ExecStart=${process.execPath} --enable-source-maps ${fixture.root}/dist/main.js`);
    expect(unit).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:test-build");
    expect(unit).toContain("Environment=HERDR_SOCKET_PATH=/tmp/test-herdr.sock");
    expect(unit).toContain(`Environment=BRIDGE_LOG_PATH=${fixture.state}/logs/service.log`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("Also=herdr-agent-swarm-log-rotate.timer");
    expect(unit).toContain("StandardOutput=null");
    expect(unit).toContain("StandardError=null");
    expect(readFileSync(join(fixture.units, "herdr-agent-swarm-log-rotate.service"), "utf8")).toContain("rotate-logs");
    expect(readFileSync(join(fixture.units, "herdr-agent-swarm-log-rotate.timer"), "utf8")).toContain("OnUnitActiveSec=1h");
    expect(statSync(join(fixture.state, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.state, "logs/service.log")).mode & 0o777).toBe(0o600);
    await expect(runServiceLifecycle("stop", fixture.environment)).resolves.toBe(0);
    expect(readFileSync(fixture.calls, "utf8").trim().split(/\n/)).toEqual([
      "--user is-active herdr-agent-swarm.service", "--user daemon-reload", "--user enable herdr-agent-swarm.service", "--user stop herdr-agent-swarm.service"
    ]);
  });

  it("optionally preserves a validated required user unit when rewriting the service", async () => {
    const fixture = createFixture();
    const environment = { ...fixture.environment, BRIDGE_REQUIRED_USER_UNIT: "herdr-headless.service" };

    await expect(runServiceLifecycle("install", environment)).resolves.toBe(0);
    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    expect(unit).toContain("Requires=herdr-headless.service");
    expect(unit).toContain("After=network-online.target herdr-headless.service");

    await expect(runServiceLifecycle("install", { ...fixture.environment, BRIDGE_REQUIRED_USER_UNIT: "bad\nunit.service" }))
      .rejects.toThrow(/BRIDGE_REQUIRED_USER_UNIT/);
  });

  it("converges private log permissions without rotating during install", async () => {
    const fixture = createFixture({ active: true });
    const logDirectory = join(fixture.state, "logs");
    const logFile = join(logDirectory, "service.log");
    mkdirSync(logDirectory, { mode: 0o755 });
    writeFileSync(logFile, "active writer content", { mode: 0o644 });
    truncateSync(logFile, 16 * 1024 * 1024 + 1);

    await runServiceLifecycle("install", fixture.environment);

    expect(statSync(logDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(statSync(logFile).size).toBe(16 * 1024 * 1024 + 1);
    expect(existsSync(`${logFile}.1`)).toBe(false);
  });

  it("rotates an oversized log during install only when inactivity is confirmed", async () => {
    const fixture = createFixture({ active: false });
    const logDirectory = join(fixture.state, "logs");
    const logFile = join(logDirectory, "service.log");
    mkdirSync(logDirectory, { mode: 0o700 });
    writeFileSync(logFile, "old log", { mode: 0o600 });
    truncateSync(logFile, 16 * 1024 * 1024 + 1);

    await runServiceLifecycle("install", fixture.environment);

    expect(statSync(logFile).size).toBe(0);
    expect(statSync(`${logFile}.1`).size).toBe(16 * 1024 * 1024 + 1);
  });

  it("does not rotate during install when unit activity is indeterminate", async () => {
    const fixture = createFixture({ activeStatus: "unknown" });
    const logDirectory = join(fixture.state, "logs");
    const logFile = join(logDirectory, "service.log");
    mkdirSync(logDirectory, { mode: 0o700 });
    writeFileSync(logFile, "old log", { mode: 0o600 });
    truncateSync(logFile, 16 * 1024 * 1024 + 1);

    await runServiceLifecycle("install", fixture.environment);

    expect(statSync(logFile).size).toBe(16 * 1024 * 1024 + 1);
    expect(existsSync(`${logFile}.1`)).toBe(false);
  });

  it.each([false, true])("rejects indeterminate restart activity before stop with force=%s", async (force) => {
    const fixture = createFixture({ activeStatus: "unknown" });
    await runServiceLifecycle("install", fixture.environment);
    writeFileSync(fixture.calls, "");

    await expect(runServiceLifecycle("restart", fixture.environment, { force })).rejects.toThrow(/cannot determine.*unit.*activity/i);
    expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
  });

  it("rejects symlink and non-regular private log paths without following or blocking", async () => {
    const directoryFixture = createFixture();
    const outside = join(directoryFixture.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(directoryFixture.state, "logs"));
    await expect(runServiceLifecycle("install", directoryFixture.environment)).rejects.toThrow(/log directory.*symlink/i);

    const fileFixture = createFixture();
    mkdirSync(join(fileFixture.state, "logs"));
    const outsideFile = join(fileFixture.root, "outside.log");
    writeFileSync(outsideFile, "outside");
    symlinkSync(outsideFile, join(fileFixture.state, "logs/service.log"));
    await expect(runServiceLifecycle("install", fileFixture.environment)).rejects.toThrow(/regular file.*service.log/i);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside");

    const fifoFixture = createFixture();
    mkdirSync(join(fifoFixture.state, "logs"));
    execFileSync("mkfifo", [join(fifoFixture.state, "logs/service.log")]);
    await expect(runServiceLifecycle("install", fifoFixture.environment)).rejects.toThrow(/regular file.*service.log/i);
  });

  it("does not traverse a symlinked log directory while reading logs", async () => {
    const fixture = createFixture();
    const outside = join(fixture.root, "outside-logs");
    mkdirSync(outside);
    writeFileSync(join(outside, "service.log"), "must-not-be-read\n");
    symlinkSync(outside, join(fixture.state, "logs"));

    await expect(runServiceLifecycle("logs", fixture.environment)).rejects.toThrow(/log directory.*symlink/i);
  });

  it("fails closed when the current service log is unavailable", async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.state, "logs"));
    await expect(runServiceLifecycle("logs", fixture.environment)).rejects.toThrow(/service log is unavailable/i);
  });

  it("rejects hard-linked current logs before install chmod or log reading", async () => {
    for (const action of ["install", "logs"] as const) {
      const fixture = createFixture();
      const logs = join(fixture.state, "logs");
      mkdirSync(logs);
      const outside = join(fixture.root, "outside.log");
      writeFileSync(outside, "outside", { mode: 0o644 });
      linkSync(outside, join(logs, "service.log"));

      await expect(runServiceLifecycle(action, fixture.environment)).rejects.toThrow(/single link.*service.log/i);
      expect(statSync(outside).mode & 0o777).toBe(0o644);
      expect(readFileSync(outside, "utf8")).toBe("outside");
    }
  });

  it("rejects a hard-linked rotated log before rotation", async () => {
    const fixture = createFixture({ active: false });
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "current");
    truncateSync(join(logs, "service.log"), 16 * 1024 * 1024 + 1);
    const outside = join(fixture.root, "outside.log");
    writeFileSync(outside, "prior");
    linkSync(outside, join(logs, "service.log.1"));

    await expect(runServiceLifecycle("install", fixture.environment)).rejects.toThrow(/single link.*service.log.1/i);
    expect(statSync(join(logs, "service.log")).size).toBe(16 * 1024 * 1024 + 1);
    expect(readFileSync(outside, "utf8")).toBe("prior");
  });

  it("rejects foreign-owned file and directory metadata", () => {
    const effectiveUid = process.geteuid?.();
    expect(effectiveUid).toBeTypeOf("number");
    expect(() => validatePrivateLogMetadata("logs", { kind: "directory", uid: effectiveUid! + 1, nlink: 2 })).toThrow(/owned by effective UID/);
    expect(() => validatePrivateLogMetadata("service.log", { kind: "file", uid: effectiveUid! + 1, nlink: 1 })).toThrow(/owned by effective UID/);
  });

  it("rejects unsafe rotated targets before replacing them", async () => {
    const fixture = createFixture({ active: false });
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "current");
    truncateSync(join(logs, "service.log"), 16 * 1024 * 1024 + 1);
    symlinkSync(join(fixture.root, "outside.log"), join(logs, "service.log.1"));

    await expect(runServiceLifecycle("install", fixture.environment)).rejects.toThrow(/regular file.*service.log.1/i);
    expect(statSync(join(logs, "service.log")).size).toBe(16 * 1024 * 1024 + 1);
  });

  it("preserves the prior rotated log when atomic rename fails", async () => {
    const fixture = createFixture({ active: false });
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "current");
    truncateSync(join(logs, "service.log"), 16 * 1024 * 1024 + 1);
    writeFileSync(join(logs, "service.log.1"), "prior");

    await expect(runServiceLifecycle("install", fixture.environment, { renameLogFile: () => { throw new Error("injected rename failure"); } }))
      .rejects.toThrow(/injected rename failure/);
    expect(readFileSync(join(logs, "service.log.1"), "utf8")).toBe("prior");
    expect(statSync(join(logs, "service.log")).size).toBe(16 * 1024 * 1024 + 1);
  });

  it("rolls back the retained generation when rotation fails after displacement", async () => {
    const fixture = createFixture({ active: false });
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "current");
    truncateSync(join(logs, "service.log"), 16 * 1024 * 1024 + 1);
    writeFileSync(join(logs, "service.log.1"), "one");
    let calls = 0;
    await expect(runServiceLifecycle("install", fixture.environment, { renameLogFile: (source, destination) => {
      calls += 1;
      if (calls === 2) throw new Error("injected mid-rotation failure");
      renameSync(source, destination);
    } })).rejects.toThrow(/mid-rotation/);
    expect(readFileSync(join(logs, "service.log"), "utf8").startsWith("current")).toBe(true);
    expect(readFileSync(join(logs, "service.log.1"), "utf8")).toBe("one");
  });

  it("escapes systemd path metacharacters in log directives", async () => {
    const fixture = createFixture();
    const state = join(fixture.root, 'state path%\\"quoted');
    const environment = { ...fixture.environment, SWARM_STATE_DIR: state };

    await runServiceLifecycle("install", environment);

    const unit = readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8");
    const escaped = `${fixture.root}/${String.raw`state\x20path%%\x5c\x22quoted/logs/service.log`}`;
    expect(unit).toContain(`Environment=BRIDGE_LOG_PATH=${escaped}`);
  });

  it.each(["\t", "\u0001"])("rejects systemd paths containing control character %j", async (control) => {
    const fixture = createFixture();
    await expect(runServiceLifecycle("install", { ...fixture.environment, SWARM_STATE_DIR: join(fixture.root, `state${control}path`) }))
      .rejects.toThrow(/invalid systemd value/);
  });

  it("prints at most the final 100 records from at most the final 1 MiB without journalctl", async () => {
    const fixture = createFixture();
    const logDirectory = join(fixture.state, "logs");
    const logFile = join(logDirectory, "service.log");
    mkdirSync(logDirectory, { mode: 0o700 });
    const records = Array.from({ length: 120 }, (_, index) => `record-${index + 1}`);
    writeFileSync(logFile, `excluded-old-record\n${"x".repeat(1024 * 1024)}\n${records.join("\n")}\n`, { mode: 0o600 });
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try {
      await expect(runServiceLifecycle("logs", fixture.environment)).resolves.toBe(0);
    } finally { write.mockRestore(); }

    expect(output).toContain(`private service log: ${logFile}`);
    expect(output).not.toContain("excluded-old-record");
    const printedRecords = output.split("\n").filter((line) => line.startsWith("record-"));
    expect(printedRecords).toHaveLength(100);
    expect(printedRecords[0]).toBe("record-21");
    expect(printedRecords.at(-1)).toBe("record-120");
    expect(existsSync(fixture.journalCalls)).toBe(false);
  });

  it("discards a partial first record when the bounded log window starts mid-line", async () => {
    const fixture = createFixture();
    const logDirectory = join(fixture.state, "logs");
    const logFile = join(logDirectory, "service.log");
    mkdirSync(logDirectory, { mode: 0o700 });
    writeFileSync(logFile, `${"partial-record".repeat(100_000)}\ncomplete-1\ncomplete-2\n`, { mode: 0o600 });
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try { await runServiceLifecycle("logs", fixture.environment); } finally { write.mockRestore(); }

    expect(output).not.toContain("partial-record");
    expect(output).toContain("complete-1\ncomplete-2\n");
  });

  it("keeps a complete first record when the bounded window starts on a newline boundary", async () => {
    const fixture = createFixture();
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    const suffix = `complete-first\n${"x".repeat(1024 * 1024 - 16)}\n`;
    writeFileSync(join(logs, "service.log"), `old\n${suffix}`);
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try { await runServiceLifecycle("logs", fixture.environment); } finally { write.mockRestore(); }
    expect(output).toContain("complete-first\n");
  });

  it("continues bounded reads after a short read", async () => {
    const fixture = createFixture();
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "one\ntwo\nthree\n");
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try {
      await runServiceLifecycle("logs", fixture.environment, { readLogChunk: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, Math.min(length, 2), position) });
    } finally { write.mockRestore(); }
    expect(output).toContain("one\ntwo\nthree\n");
  });

  it("filters structured logs across the bounded rotated chain", async () => {
    const fixture = createFixture();
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log.2"), JSON.stringify({ time: "2026-09-18T09:00:00Z", level: 50, component: "publisher", eventId: "old" }) + "\n");
    writeFileSync(join(logs, "service.log.1"), "not-json\n" + JSON.stringify({ time: "2026-09-18T10:00:00Z", level: 40, component: "publisher", eventId: "target" }) + "\n");
    writeFileSync(join(logs, "service.log"), JSON.stringify({ time: "2026-09-18T11:00:00Z", level: 30, component: "coordinator", eventId: "target" }) + "\n");
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try { await runServiceLifecycle("logs", fixture.environment, { logQuery: { includeRotated: true, json: true, level: "warn", component: "publisher", since: "2026-09-18T09:30:00Z" } }); } finally { write.mockRestore(); }
    expect(output).toContain('"eventId":"target"');
    expect(output).not.toContain("not-json");
    expect(output).not.toContain('"eventId":"old"');
    expect(output).not.toContain("private service log:");
  });

  it("parses bounded Agent log query options and rejects invalid values", () => {
    expect(parseLogQueryArgs(["--lines", "25", "--max-bytes", "4096", "--level", "warn", "--event-id", "evt-1", "--include-rotated", "--json"])).toEqual({ lines: 25, maxBytes: 4096, level: "warn", eventId: "evt-1", includeRotated: true, json: true });
    expect(() => parseLogQueryArgs(["--lines", "0"])).toThrow(/--lines/);
    expect(() => parseLogQueryArgs(["--level", "verbose"])).toThrow(/--level/);
    expect(() => parseLogQueryArgs(["--since", "not-a-date"])).toThrow(/--since/);
    expect(() => parseLogQueryArgs(["--unknown"])).toThrow(/invalid logs option/);
  });

  it("retains one rotated generation", async () => {
    const fixture = createFixture({ active: false });
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log.1"), "one");
    writeFileSync(join(logs, "service.log"), "current");
    truncateSync(join(logs, "service.log"), 16 * 1024 * 1024 + 1);
    await runServiceLifecycle("install", fixture.environment);
    expect(readFileSync(join(logs, "service.log.1"), "utf8").startsWith("current")).toBe(true);
    expect(statSync(join(logs, "service.log")).size).toBe(0);
  });

  it("rotates an active service log and signals only its verified MainPID to reopen", async () => {
    const fixture = createFixture({ active: true, mainPid: 4242 });
    await runServiceLifecycle("install", fixture.environment);
    const logFile = join(fixture.state, "logs/service.log");
    writeFileSync(logFile, "current");
    truncateSync(logFile, 16 * 1024 * 1024 + 1);
    let probeCount = 0;
    const signalProcess = vi.fn();

    await expect(runServiceLifecycle("rotate-logs", fixture.environment, {
      signalProcess, processHasOpenFile: (pid, path) => { expect(pid).toBe(4242); expect(path).toBe(logFile); return ++probeCount !== 2; }
    })).resolves.toBe(0);

    expect(signalProcess).toHaveBeenCalledWith(4242, "SIGUSR2");
    expect(statSync(logFile).size).toBe(0);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(statSync(`${logFile}.1`).size).toBe(16 * 1024 * 1024 + 1);
  });

  it("fails closed before rotation when active MainPID does not own the log", async () => {
    const fixture = createFixture({ active: true, mainPid: 4242 });
    await runServiceLifecycle("install", fixture.environment);
    const logFile = join(fixture.state, "logs/service.log");
    truncateSync(logFile, 16 * 1024 * 1024 + 1);
    const signalProcess = vi.fn();

    await expect(runServiceLifecycle("rotate-logs", fixture.environment, { signalProcess, processHasOpenFile: () => false }))
      .rejects.toThrow(/MainPID.*own/);
    expect(signalProcess).not.toHaveBeenCalled();
    expect(statSync(logFile).size).toBe(16 * 1024 * 1024 + 1);
  });

  it("retries reopen without rotating again after a prior signal failure", async () => {
    const fixture = createFixture({ active: true, mainPid: 4242 });
    await runServiceLifecycle("install", fixture.environment);
    const logFile = join(fixture.state, "logs/service.log");
    truncateSync(logFile, 16 * 1024 * 1024 + 1);
    const firstSignal = vi.fn(() => { throw new Error("signal failed"); });
    await expect(runServiceLifecycle("rotate-logs", fixture.environment, { signalProcess: firstSignal, processHasOpenFile: (_pid, path) => path.endsWith(".1") ? false : true }))
      .rejects.toThrow(/signal failed/);
    const rotatedSize = statSync(`${logFile}.1`).size;
    let reopened = false;
    const retrySignal = vi.fn(() => { reopened = true; });

    await expect(runServiceLifecycle("rotate-logs", fixture.environment, { signalProcess: retrySignal, processHasOpenFile: (_pid, path) => path === logFile ? reopened : !reopened }))
      .resolves.toBe(0);
    expect(retrySignal).toHaveBeenCalledOnce();
    expect(statSync(`${logFile}.1`).size).toBe(rotatedSize);
  });

  it("rejects concurrent log rotation through the state lock", async () => {
    const fixture = createFixture({ active: false });
    await runServiceLifecycle("install", fixture.environment);
    writeFileSync(join(fixture.state, ".log-rotation.lock"), "held");
    await expect(runServiceLifecycle("rotate-logs", fixture.environment)).rejects.toThrow(/already active/);
  });

  it("applies custom line and byte limits", async () => {
    const fixture = createFixture();
    const logs = join(fixture.state, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "service.log"), "excluded\none\ntwo\nthree\n");
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try { await runServiceLifecycle("logs", fixture.environment, { logQuery: { lines: 2, maxBytes: 14 } }); } finally { write.mockRestore(); }
    expect(output).not.toContain("excluded");
    expect(output.endsWith("two\nthree\n")).toBe(true);
  });

  it("preserves config and state while uninstalling only the service", async () => {
    const fixture = createFixture();
    await runServiceLifecycle("install", fixture.environment);
    await expect(runServiceLifecycle("uninstall", fixture.environment)).resolves.toBe(0);
    expect(() => readFileSync(join(fixture.units, "herdr-agent-swarm.service"))).toThrow();
    expect(readFileSync(join(fixture.config, ".env"), "utf8")).toContain("LARK_APP_ID");
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user disable --now herdr-agent-swarm.service");
  });

  it("refreshes the unit identity before restarting a rebuilt service", async () => {
    const fixture = createFixture({ active: false });
    await runServiceLifecycle("install", fixture.environment);
    writeFileSync(join(fixture.root, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: "sha256:rebuilt", gitCommit: null }));
    await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "300" }, { force: true })).rejects.toThrow();
    expect(readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8")).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:rebuilt");
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user stop herdr-agent-swarm.service\n--user daemon-reload\n--user start --no-block herdr-agent-swarm.service");
  });

  it("refuses restart when an inactive unit still has a service on the configured listener", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus({ operational: { prompts: { running: 1, queued: 0 } } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ active: false, port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      writeFileSync(fixture.calls, "");

      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/unit is inactive.*listener.*still responds/i);
      expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("rotates an oversized log before starting an inactive unit", async () => {
    const fixture = createFixture({ active: false });
    await runServiceLifecycle("install", fixture.environment);
    const logFile = join(fixture.state, "logs/service.log");
    writeFileSync(logFile, "old log");
    truncateSync(logFile, 16 * 1024 * 1024 + 1);
    writeFileSync(fixture.calls, "");

    await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "20" })).rejects.toThrow(/did not complete startup/);

    expect(statSync(logFile).size).toBe(0);
    expect(statSync(`${logFile}.1`).size).toBe(16 * 1024 * 1024 + 1);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(fixture.calls, "utf8")).toContain("--user is-active herdr-agent-swarm.service\n--user daemon-reload\n--user enable --now herdr-agent-swarm.service");
  });

  it("fails closed when restart cannot stop the active writer", async () => {
    const fixture = createFixture({ active: false, stopExit: 7 });
    await runServiceLifecycle("install", fixture.environment);
    const unitFile = join(fixture.units, "herdr-agent-swarm.service");
    const unitBefore = readFileSync(unitFile, "utf8");
    const logFile = join(fixture.state, "logs/service.log");
    truncateSync(logFile, 16 * 1024 * 1024 + 1);
    writeFileSync(join(fixture.root, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: "sha256:rebuilt", gitCommit: null }));
    writeFileSync(fixture.calls, "");

    await expect(runServiceLifecycle("restart", fixture.environment, { force: true })).resolves.toBe(7);

    expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n--user stop herdr-agent-swarm.service\n");
    expect(statSync(logFile).size).toBe(16 * 1024 * 1024 + 1);
    expect(existsSync(`${logFile}.1`)).toBe(false);
    expect(readFileSync(unitFile, "utf8")).toBe(unitBefore);
  });

  it("refuses an unforced restart while the running service reports active turns", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/status") {
        response.end(JSON.stringify({ identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:old-build" }, operational: { prompts: { running: 2, queued: 3 } } }));
        return;
      }
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-agent-swarm", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      writeFileSync(fixture.calls, "");
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/2 running.*3 queued.*unknown active.*--force/);
      expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses restart when an active worker remains after durable running work clears", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-agent-swarm" }, operational: { prompts: { running: 0, queued: 1 } }, promptWorker: { activeTurnWorkers: 1 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/0 running.*1 queued.*1 active/);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses restart while multi-agent work remains active or uncertain", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-agent-swarm" }, operational: { prompts: { running: 0, queued: 0 } }, promptWorker: { activeTurnWorkers: 0 }, instanceWorker: { activeDispatchWorkers: 0, activeObservers: 1, activeTurns: 1, uncertainTurns: 2 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/instance.*observer.*uncertain.*--force/i);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("uses instance work to block restart even when legacy prompt metrics are absent", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-agent-swarm" }, instanceWorker: { activeDispatchWorkers: 1, activeObservers: 0, activeTurns: 1, uncertainTurns: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/instance work/i);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses an unforced restart when the active unit status belongs to another service", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", identity: { serviceId: "another-service" }, operational: { prompts: { running: 0, queued: 0 } }, promptWorker: { activeTurnWorkers: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      writeFileSync(fixture.calls, "");
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/identity.*another-service.*--force/i);
      expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("refuses an unforced restart when the active unit status is unavailable", async () => {
    const unavailable = createFixture({ port: 1 });
    await runServiceLifecycle("install", unavailable.environment);
    writeFileSync(unavailable.calls, "");
    await expect(runServiceLifecycle("restart", unavailable.environment)).rejects.toThrow(/status.*unreachable.*--force/i);
    expect(readFileSync(unavailable.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
  });

  it("refuses an unforced restart when active-unit work metrics are incomplete", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ identity: { serviceId: "herdr-agent-swarm" }, operational: { prompts: { queued: 0 } } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/incomplete.*--force/i);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    ["queued prompts", { operational: { prompts: { running: 0, queued: 1 }, pendingOutbox: 0 } }, /queued prompts/i],
    ["ready outbox work", { operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 1, outboxWork: { ready: 1, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0 } } }, /1 ready/i],
    ["in-flight outbox work", { operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 1, outboxWork: { ready: 0, inFlight: 1, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0 } } }, /1 in-flight/i],
    ["retry-wait outbox work", { operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 1, outboxWork: { ready: 0, inFlight: 0, retryWait: 1, cooldownWait: 0, waitingBehindLane: 0 } } }, /1 retry-wait/i],
    ["cooldown-wait outbox work", { operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 1, outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 1, waitingBehindLane: 0 } } }, /1 cooldown-wait/i],
    ["active deliveries", { outboxDispatcher: { activeDeliveries: 1 } }, /active deliveries/i],
    ["incomplete startup recovery", { startupRecovery: { state: "running" } }, /startup recovery/i],
    ["unhealthy SQLite integrity state", { sqliteIntegrity: { state: "degraded", quickCheck: "ok" } }, /sqlite integrity/i],
    ["failed SQLite quick check", { sqliteIntegrity: { state: "healthy", quickCheck: "failed" } }, /sqlite integrity/i]
  ])("refuses restart with %s", async (_name, override, expected) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus(override)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(expected);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain("restart --no-block");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    ["outboxWork", { operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 0 } }],
    ["activeDeliveries", { outboxDispatcher: {} }],
    ["startupRecovery", { startupRecovery: {} }],
    ["sqliteIntegrity", { sqliteIntegrity: {} }]
  ])("fails closed when restart safety field %s is missing", async (_name, override) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus(override)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", fixture.environment)).rejects.toThrow(/incomplete.*--force/i);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("allows an unforced restart when pending outbox rows are safely quarantined", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({
        operational: {
          prompts: { running: 0, queued: 0 }, pendingOutbox: 22,
          outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 22 }
        }
      })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("uses the installed environment file instead of shell config values", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", { ...fixture.environment, BRIDGE_HTTP_PORT: "1" });
      await expect(runServiceLifecycle("restart", { ...fixture.environment, BRIDGE_HTTP_PORT: "1", SWARM_SERVICE_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("rejects force for lifecycle actions other than restart", async () => {
    const fixture = createFixture();
    await expect(runServiceLifecycle("start", fixture.environment, { force: true })).rejects.toThrow(/only for restart/);
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "1000" }, { force: true })).resolves.toBe(0);
      expect(statusRequests).toBeGreaterThanOrEqual(2);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user start --no-block herdr-agent-swarm.service");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    ["foreign identity", { identity: { serviceId: "another-service", buildId: "sha256:test-build" } }, /identity.*another-service/i],
    ["incomplete recovery", { startupRecovery: { state: "running" } }, /startup recovery.*running/i],
    ["unhealthy SQLite", { sqliteIntegrity: { state: "degraded", quickCheck: "ok" } }, /SQLite integrity/i]
  ])("does not let force bypass %s validation", async (_name, override, expected) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus(override)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      writeFileSync(fixture.calls, "");
      await expect(runServiceLifecycle("restart", fixture.environment, { force: true })).rejects.toThrow(expected);
      expect(readFileSync(fixture.calls, "utf8")).toBe("--user is-active herdr-agent-swarm.service\n");
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(statusRequests).toBeGreaterThanOrEqual(2);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user start --no-block herdr-agent-swarm.service");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not accept liveness before startup recovery completes", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/status") {
        response.end(JSON.stringify({
          status: "ok", identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:test-build" },
          startupRecovery: { state: "running" }
        }));
        return;
      }
      response.end(JSON.stringify({ status: "ok", serviceId: "herdr-agent-swarm", buildId: "sha256:test-build" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1500" })).resolves.toBe(0);
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1000" })).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("requires readiness when setup starts the service", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.statusCode = 503; response.end(JSON.stringify({ status: "not_ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1000" }, { requireReady: true }))
        .rejects.toThrow(/readiness.*not_ready/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refreshes the unit identity before starting a rebuilt stopped service", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:rebuilt" } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      writeFileSync(join(fixture.root, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: "sha256:rebuilt", gitCommit: null }));
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1000" })).resolves.toBe(0);
      expect(readFileSync(join(fixture.units, "herdr-agent-swarm.service"), "utf8")).toContain("Environment=BRIDGE_EXPECTED_BUILD_ID=sha256:rebuilt");
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user daemon-reload\n--user enable --now herdr-agent-swarm.service");
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
        SWARM_SERVICE_START_TIMEOUT_MS: "1000"
      };
      await runServiceLifecycle("install", environment);
      writeFileSync(fixture.calls, "");
      await expect(runServiceLifecycle("start", environment)).resolves.toBe(0);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user enable --now herdr-agent-swarm.service");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refuses service control before installation", async () => {
    const fixture = createFixture();
    await expect(runServiceLifecycle("start", fixture.environment)).rejects.toThrow(/service is not installed/);
  });

  it("returns nonzero status when the configured listener is not owned by the canonical unit", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const fixture = createFixture({ port, mainPid: 4100, listenerPid: 4200 });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user show herdr-agent-swarm.service --property ActiveState --property MainPID");
      expect(readFileSync(fixture.ssCalls, "utf8")).toContain("-H -ltnp");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("reports an unavailable unit instead of inactive when the user bus cannot be queried", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write);
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port, systemctlError: "Failed to connect to bus: No data available" });

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);

      const status = JSON.parse(output) as { active: boolean; unitState?: string; unitStatusDetail?: string | null; ownership?: { detail?: string } };
      expect(status.active).toBe(false);
      expect(status.unitState).toBe("unavailable");
      expect(status.unitStatusDetail).toBe("Failed to connect to bus: No data available");
      expect(status.ownership?.detail).toContain("systemd unavailable: Failed to connect to bus: No data available");
    } finally {
      write.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects canonical IPv6 ownership when the configured IPv4 endpoint is foreign", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const fixture = createFixture({ port, mainPid: 4100, ssOutput: [
        `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=4200,fd=20))`,
        `LISTEN 0 511 [::1]:${port} [::]:* users:(("node",pid=4100,fd=21))`
      ].join("\n") });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("rejects canonical IPv4 ownership when the configured IPv6 endpoint is foreign", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const fixture = createFixture({ host: "::1", port, mainPid: 4100, ssOutput: [
        `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=4100,fd=20))`,
        `LISTEN 0 511 [::1]:${port} [::]:* users:(("node",pid=4200,fd=21))`
      ].join("\n") });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("uses the actual connected loopback address for localhost ownership", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    try {
      const address = server.address() as AddressInfo;
      const actualEndpoint = address.family === "IPv6" ? `[::1]:${address.port}` : `127.0.0.1:${address.port}`;
      const otherEndpoint = address.family === "IPv6" ? `127.0.0.1:${address.port}` : `[::1]:${address.port}`;
      const fixture = createFixture({ host: "localhost", port: address.port, mainPid: 4100, ssOutput: [
        `LISTEN 0 511 ${actualEndpoint} 0.0.0.0:* users:(("node",pid=4100,fd=20))`,
        `LISTEN 0 511 ${otherEndpoint} 0.0.0.0:* users:(("node",pid=4200,fd=21))`
      ].join("\n") });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    ["malformed", "this is not socket output", 0],
    ["truncated", "LISTEN 0 511 127.0.0.1:39001", 0],
    ["failed", "", 1]
  ])("fails closed when ss output is %s", async (_name, ssOutput, ssExit) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const output = ssOutput.replace("39001", String(port));
      const fixture = createFixture({ port, ssOutput: output, ssExit });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    ["missing", { identity: undefined }],
    ["foreign", { identity: { serviceId: "another-service", buildId: "sha256:test-build" } }]
  ])("returns nonzero status for %s service identity", async (_name, override) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus(override)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("status", fixture.environment)).resolves.toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("does not accept startup from a foreign process on the configured listener", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port, mainPid: 4100, listenerPid: 4200 });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/listener.*PID.*canonical unit.*MainPID/i);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("does not let forced restart bypass foreign listener ownership", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedStartupStatus()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port, mainPid: 4100, listenerPid: 4200 });
      await runServiceLifecycle("install", fixture.environment);

      await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "300" }, { force: true }))
        .rejects.toThrow(/listener.*PID.*canonical unit.*MainPID/i);
      expect(readFileSync(fixture.calls, "utf8")).toContain("--user start --no-block herdr-agent-swarm.service");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("does not accept a healthy port unless the managed unit is active", async () => {
    const fixture = createFixture({ active: false });
    await runServiceLifecycle("install", fixture.environment);
    await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
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
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1000" })).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("accepts a ready expected build whose operational status is degraded", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ status: "degraded" })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "1000" }, { requireReady: true })).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects an unsupported startup status even when identity and ownership match", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ status: "starting" })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/status starting.*observed build sha256:test-build.*startup completed/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a healthy response from a stale build", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      statusRequests += 1;
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:stale-build" } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("start", { ...fixture.environment, SWARM_SERVICE_START_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/expected build sha256:test-build.*observed build sha256:stale-build.*startup completed/);
      expect(existsSync(fixture.ssCalls) ? readFileSync(fixture.ssCalls, "utf8") : "").toBe("");
      const runtimeSamples = readFileSync(fixture.calls, "utf8").split("\n").filter((call) => call.includes("--property ActiveState"));
      expect(runtimeSamples).toHaveLength(statusRequests);
      expect(runtimeSamples.every((call) => call.includes("--property MainPID"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports the final active unit and stale build when restart handover times out", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/ready") { response.end(JSON.stringify({ status: "ready" })); return; }
      response.end(JSON.stringify(completedStartupStatus({ identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:stale-build" } })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const fixture = createFixture({ port: (server.address() as AddressInfo).port });
      await runServiceLifecycle("install", fixture.environment);
      await expect(runServiceLifecycle("restart", { ...fixture.environment, SWARM_SERVICE_RESTART_TIMEOUT_MS: "300" }))
        .rejects.toThrow(/restart did not complete startup with expected build sha256:test-build.*unit active.*observed build sha256:stale-build.*startup completed/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function completedStartupStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok", identity: { serviceId: "herdr-agent-swarm", buildId: "sha256:test-build" },
    startupRecovery: { state: "completed" }, operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 0, outboxWork: { ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0 } },
    promptWorker: { activeTurnWorkers: 0 }, instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 },
    outboxDispatcher: { activeDeliveries: 0 }, sqliteIntegrity: { state: "healthy", quickCheck: "ok" },
    ...overrides
  };
}

function createActivationFixture(options: { previous?: boolean; failFirstReload?: boolean; failEveryReload?: boolean; failEnable?: boolean; priorEnabled?: "enabled" | "disabled" } = {}) {
  const base = createFixture({ active: false });
  const releases = join(base.state, "releases");
  const hash = "a".repeat(64);
  const commit = "b".repeat(40);
  const candidate = join(releases, `${hash}-${commit.slice(0, 12)}`);
  mkdirSync(join(candidate, "dist"), { recursive: true });
  writeFileSync(join(candidate, "dist/main.js"), "// candidate\n");
  writeFileSync(join(candidate, "dist/build-info.json"), JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.4.0", buildId: `sha256:${hash}`, gitCommit: commit }));
  const current = join(base.state, "current");
  const unit = join(base.units, "herdr-agent-swarm.service");
  let previous = "";
  if (options.previous) {
    previous = join(releases, `${"c".repeat(64)}-${"d".repeat(12)}`);
    mkdirSync(previous, { recursive: true });
    symlinkSync(previous, current);
    writeFileSync(unit, "previous unit\n", { mode: 0o640 });
  }
  const bin = base.environment.PATH!.split(":")[0]!;
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(base.calls)}
if [ "$2" = "is-active" ]; then echo inactive; exit 3; fi
if [ "$2" = "is-enabled" ]; then echo ${options.priorEnabled ?? "disabled"}; ${options.priorEnabled === "enabled" ? "exit 0" : "exit 1"}; fi
if [ "$2" = "daemon-reload" ]; then
  count=$(grep -c 'daemon-reload' ${JSON.stringify(base.calls)})
  ${options.failEveryReload ? "exit 7" : options.failFirstReload ? '[ "$count" -eq 1 ] && exit 7' : ":"}
fi
if [ "$2" = "enable" ] && ${options.failEnable ? "true" : "false"}; then exit 8; fi
exit 0
`);
  chmodSync(join(bin, "systemctl"), 0o755);
  return { ...base, candidate, previous, current, unit, marker: join(base.state, ".release-activation.json"), environment: { ...base.environment, SWARM_ROOT: candidate, SWARM_RELEASE_CANDIDATE: candidate } };
}

function createFixture(options: { active?: boolean; activeStatus?: "unknown"; stopExit?: number; port?: number; mainPid?: number; listenerPid?: number; host?: string; ssOutput?: string; ssExit?: number; systemctlError?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-swarm-root-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const dist = join(root, "dist");
  const units = join(root, "units");
  const bin = join(root, "bin");
  const calls = join(root, "systemctl.calls");
  const ssCalls = join(root, "ss.calls");
  const journalCalls = join(root, "journalctl.calls");
  for (const directory of [config, state, dist, units, bin]) mkdirSync(directory);
  writeFileSync(join(config, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: root }] }));
  writeFileSync(join(config, ".env"), [
    "LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot", "LARK_ALLOWED_OPEN_IDS=ou_user", "LARK_ADMIN_OPEN_IDS=ou_user",
    `BRIDGE_HTTP_PORT=${options.port ?? 39001}`, `BRIDGE_HTTP_HOST=${options.host ?? "127.0.0.1"}`
  ].join("\n") + "\n");
  writeFileSync(join(dist, "main.js"), "// fixture\n");
  writeFileSync(join(dist, "build-info.json"), JSON.stringify({ serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: "sha256:test-build", gitCommit: null }));
  const active = options.active ?? true;
  const activity = options.activeStatus === "unknown" ? "echo unknown; exit 4" : active ? "echo active; exit 0" : "echo inactive; exit 3";
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\n' "$*" >> ${JSON.stringify(calls)}\n${options.systemctlError ? `printf '%s\n' ${JSON.stringify(options.systemctlError)} >&2; exit 1` : ""}\nif [ "$2" = "is-active" ]; then ${activity}; fi\nif [ "$2" = "show" ]; then\n  if [ "$5" = "ActiveState" ]; then printf 'ActiveState=%s\nMainPID=%s\n' ${active ? "active" : "inactive"} ${options.mainPid ?? process.pid}; else echo ${options.mainPid ?? process.pid}; fi\n  exit 0\nfi\nif [ "$2" = "stop" ]; then exit ${options.stopExit ?? 0}; fi\nexit 0\n`);
  const ssOutput = options.ssOutput ?? `LISTEN 0 511 127.0.0.1:${options.port ?? 39001} 0.0.0.0:* users:(("node",pid=${options.listenerPid ?? process.pid},fd=20))`;
  writeFileSync(join(bin, "ss"), `#!/bin/sh\nprintf '%s\n' "$*" >> ${JSON.stringify(ssCalls)}\nprintf '%b\n' ${JSON.stringify(ssOutput)}\nexit ${options.ssExit ?? 0}\n`);
  writeFileSync(join(bin, "journalctl"), `#!/bin/sh\nprintf '%s\n' "$*" >> ${JSON.stringify(journalCalls)}\nexit 0\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "journalctl"), 0o755);
  chmodSync(join(bin, "ss"), 0o755);
  return { root, config, state, units, calls, ssCalls, journalCalls, environment: {
    PATH: `${bin}:${process.env.PATH}`,
    SWARM_ROOT: root, SWARM_CONFIG_DIR: config, SWARM_STATE_DIR: state,
    BRIDGE_SYSTEMD_UNIT_DIR: units, HERDR_SOCKET_PATH: "/tmp/test-herdr.sock"
  } };
}
