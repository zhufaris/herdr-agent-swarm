import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runStandaloneCutover, type CutoverDependencies, type CutoverStatus } from "../src/cli/swarm-service-cutover.js";

describe("standalone service cutover", () => {
  it("copies private compatibility configuration and preserves the database path", async () => {
    const fixture = createFixture();
    const dependencies = createDependencies(fixture);
    await expect(runStandaloneCutover(fixture.environment, dependencies)).resolves.toBe(0);
    expect(statSync(fixture.swarmConfig).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.swarmConfig, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fixture.swarmConfig, "projects.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(fixture.swarmConfig, ".env"), "utf8")).toContain("BRIDGE_DATABASE_PATH=" + fixture.database);
  });

  it.each([
    ["running prompt", status({ operational: { prompts: { running: 1, queued: 0 }, pendingOutbox: 0 } })],
    ["active prompt worker", status({ promptWorker: { activeTurnWorkers: 1 } })],
    ["uncertain instance turn", status({ instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 1 } })],
    ["pending outbox", status({ operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 1 } })]
  ])("refuses cutover with %s", async (_label, currentStatus) => {
    const fixture = createFixture();
    const dependencies = createDependencies(fixture, { currentStatus });
    await expect(runStandaloneCutover(fixture.environment, dependencies)).rejects.toThrow(/cutover blocked/);
    expect(dependencies.stopService).not.toHaveBeenCalled();
    expect(dependencies.runLifecycle).not.toHaveBeenCalled();
  });

  it("stops compatibility before starting standalone and disables compatibility last", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const dependencies = createDependencies(fixture, { events });
    await expect(runStandaloneCutover(fixture.environment, dependencies)).resolves.toBe(0);
    expect(events).toEqual([
      "stop:herdr-lark-bridge.service", "lifecycle:install", "lifecycle:start", "disable:herdr-lark-bridge.service"
    ]);
  });

  it("stops standalone and restores the previously active compatibility service after failed startup", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const dependencies = createDependencies(fixture, { events, failStandaloneStart: true });
    await expect(runStandaloneCutover(fixture.environment, dependencies)).rejects.toThrow(/standalone startup failed/);
    expect(events).toEqual([
      "stop:herdr-lark-bridge.service", "lifecycle:install", "lifecycle:start",
      "stop:herdr-agent-swarm.service", "enable:herdr-lark-bridge.service", "compatibility:start"
    ]);
  });

  it("restores compatibility without stopping an inactive standalone unit after failed install", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const dependencies = createDependencies(fixture, { events, failStandaloneInstall: true, rejectInactiveStop: true });
    await expect(runStandaloneCutover(fixture.environment, dependencies)).rejects.toThrow(/standalone install failed/);
    expect(events).toEqual([
      "stop:herdr-lark-bridge.service", "lifecycle:install",
      "enable:herdr-lark-bridge.service", "compatibility:start"
    ]);
  });

  it("is idempotent when standalone already owns the endpoint", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const dependencies = createDependencies(fixture, { events, oldActive: false, oldEnabled: false, newActive: true });
    await expect(runStandaloneCutover(fixture.environment, dependencies)).resolves.toBe(0);
    expect(events).toEqual(["lifecycle:start", "disable:herdr-lark-bridge.service"]);
  });
});

function status(overrides: Record<string, unknown> = {}): CutoverStatus {
  return {
    status: "ok", identity: { serviceId: "herdr-lark-bridge", buildId: "sha256:test" }, readiness: { status: "ready" },
    startupRecovery: { state: "completed" }, sqliteIntegrity: { state: "healthy", quickCheck: "ok" }, lease: { held: true },
    operational: { prompts: { running: 0, queued: 0 }, pendingOutbox: 0 }, promptWorker: { activeTurnWorkers: 0 },
    instanceWorker: { activeDispatchWorkers: 0, activeObservers: 0, activeTurns: 0, uncertainTurns: 0 },
    outboxDispatcher: { activeDeliveries: 0 }, ...overrides
  } as CutoverStatus;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "swarm-cutover-"));
  const compatibilityConfig = join(root, "compat-config");
  const compatibilityState = join(root, "compat-state");
  const swarmConfig = join(root, "swarm-config");
  const swarmState = join(root, "swarm-state");
  const database = join(root, "legacy", "bridge.db");
  mkdirSync(compatibilityConfig);
  mkdirSync(compatibilityState);
  mkdirSync(join(root, "legacy"));
  writeFileSync(database, "fixture");
  writeFileSync(join(compatibilityConfig, ".env"), [
    "LARK_APP_ID=app", "LARK_APP_SECRET=secret", "LARK_CHAT_ID=chat", "LARK_BOT_OPEN_ID=bot",
    "BRIDGE_DATABASE_PATH=" + database, "BRIDGE_HTTP_HOST=127.0.0.1", "BRIDGE_HTTP_PORT=8787"
  ].join("\n") + "\n", { mode: 0o600 });
  writeFileSync(join(compatibilityConfig, "projects.json"), JSON.stringify({ defaultProjectId: "test", projects: [{ id: "test", displayName: "Test", description: "Test", workspaceId: "w1", cwd: root }] }), { mode: 0o600 });
  return {
    root, compatibilityConfig, compatibilityState, swarmConfig, swarmState, database,
    environment: {
      SWARM_ROOT: root, SWARM_CONFIG_DIR: swarmConfig, SWARM_STATE_DIR: swarmState,
      SWARM_COMPAT_CONFIG_DIR: compatibilityConfig, SWARM_COMPAT_STATE_DIR: compatibilityState,
      BRIDGE_SYSTEMD_SERVICE_NAME: "herdr-agent-swarm.service", SWARM_COMPAT_SERVICE_NAME: "herdr-lark-bridge.service"
    }
  };
}

function createDependencies(_fixture: ReturnType<typeof createFixture>, options: {
  events?: string[]; currentStatus?: CutoverStatus; failStandaloneStart?: boolean;
  failStandaloneInstall?: boolean; rejectInactiveStop?: boolean;
  oldActive?: boolean; oldEnabled?: boolean; newActive?: boolean;
} = {}): CutoverDependencies & Record<string, ReturnType<typeof vi.fn>> {
  const events = options.events ?? [];
  let oldActive = options.oldActive ?? true;
  let newActive = options.newActive ?? false;
  return {
    validateConfiguration: vi.fn(),
    readStatus: vi.fn(async () => options.currentStatus ?? status()),
    serviceState: vi.fn(async (name: string) => name === "herdr-lark-bridge.service"
      ? { active: oldActive, enabled: options.oldEnabled ?? true }
      : { active: newActive, enabled: true }),
    runLifecycle: vi.fn(async (action: string) => {
      events.push("lifecycle:" + action);
      if (action === "install" && options.failStandaloneInstall) throw new Error("standalone install failed");
      if (action === "start") {
        newActive = true;
        if (options.failStandaloneStart) throw new Error("standalone startup failed");
      }
      return 0;
    }),
    startCompatibility: vi.fn(async () => { events.push("compatibility:start"); oldActive = true; }),
    stopService: vi.fn(async (name: string) => {
      if (name === "herdr-agent-swarm.service" && !newActive && options.rejectInactiveStop) throw new Error("unit not loaded");
      events.push("stop:" + name);
      if (name === "herdr-lark-bridge.service") oldActive = false; else newActive = false;
    }),
    startService: vi.fn(async (name: string) => { events.push("start:" + name); if (name === "herdr-lark-bridge.service") oldActive = true; }),
    enableService: vi.fn(async (name: string) => { events.push("enable:" + name); }),
    disableService: vi.fn(async (name: string) => { events.push("disable:" + name); })
  } as CutoverDependencies & Record<string, ReturnType<typeof vi.fn>>;
}
