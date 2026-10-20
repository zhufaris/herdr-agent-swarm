import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildIdentity } from "../src/runtime/build-identity.js";
import { ReleaseActivator, type ReleaseActivationPaths } from "../src/cli/service-lifecycle/release-activator.js";

describe("ReleaseActivator", () => {
  it("commits current only after unit installation, reload, and enable", () => {
    const fixture = createFixture();
    const events: string[] = [];

    const result = new ReleaseActivator().activate({
      paths: fixture.paths, environment: {}, identity: fixture.identity, candidateValue: fixture.candidate,
      writeUnits: () => { events.push("write-units"); writeUnits(fixture.paths, "candidate unit\n"); },
      runSystemd: (args) => { events.push(args.at(1) ?? "unknown"); return 0; },
      readEnabledState: () => "disabled",
      renameCurrentLink: (source, destination) => { events.push("commit-current"); renameSync(source, destination); },
      writeStdout: (message) => events.push(message.trim()),
      writeStderr: () => undefined
    });

    expect(result).toBe(0);
    expect(events.slice(0, 4)).toEqual(["write-units", "daemon-reload", "enable", "commit-current"]);
    expect(realpathSync(fixture.paths.currentLink)).toBe(fixture.candidate);
    expect(existsSync(fixture.paths.activationMarker)).toBe(false);
  });

  it("activates the owned TraeX plugin before publishing the release", () => {
    const fixture = createFixture();
    const events: string[] = [];

    const result = new ReleaseActivator().activate({
      paths: fixture.paths, environment: {}, identity: fixture.identity, candidateValue: fixture.candidate,
      ownedPlugin: { activate: () => events.push("activate-plugin"), rollback: () => events.push("rollback-plugin") },
      writeUnits: () => { events.push("write-units"); writeUnits(fixture.paths, "candidate unit\n"); },
      runSystemd: (args) => { events.push(args.at(1) ?? "unknown"); return 0; },
      readEnabledState: () => "disabled",
      renameCurrentLink: (source, destination) => { events.push("commit-current"); renameSync(source, destination); },
      writeStdout: () => undefined,
      writeStderr: () => undefined
    });

    expect(result).toBe(0);
    expect(events).toEqual(["activate-plugin", "write-units", "daemon-reload", "enable", "commit-current"]);
  });

  it("rolls back the owned TraeX plugin when release activation fails", () => {
    const fixture = createFixture(true);
    const events: string[] = [];

    const result = new ReleaseActivator().activate({
      paths: fixture.paths, environment: {}, identity: fixture.identity, candidateValue: fixture.candidate,
      ownedPlugin: { activate: () => events.push("activate-plugin"), rollback: () => events.push("rollback-plugin") },
      writeUnits: () => writeUnits(fixture.paths, "candidate unit\n"),
      runSystemd: (args, tolerateFailure) => args.at(1) === "daemon-reload" && tolerateFailure !== true ? 7 : 0,
      readEnabledState: () => "enabled",
      writeStdout: () => undefined,
      writeStderr: () => undefined
    });

    expect(result).toBe(7);
    expect(events).toEqual(["activate-plugin", "rollback-plugin"]);
  });

  it("does not touch systemd when owned plugin activation fails before unit mutation", () => {
    const fixture = createFixture(true);
    const events: string[] = [];

    expect(() => new ReleaseActivator().activate({
      paths: fixture.paths, environment: {}, identity: fixture.identity, candidateValue: fixture.candidate,
      ownedPlugin: {
        activate: () => { events.push("activate-plugin"); throw new Error("plugin failed"); },
        rollback: () => events.push("rollback-plugin")
      },
      writeUnits: () => events.push("write-units"),
      runSystemd: () => { events.push("systemd"); return 0; },
      readEnabledState: () => "enabled",
      writeStdout: () => undefined,
      writeStderr: () => undefined
    })).toThrow("plugin failed");

    expect(events).toEqual(["activate-plugin", "rollback-plugin"]);
    expect(existsSync(fixture.paths.activationMarker)).toBe(false);
  });

  it("compensates a command failure and returns its original exit code", () => {
    const fixture = createFixture(true);
    const calls: string[] = [];
    const priorUnit = readFileSync(fixture.paths.unitFile, "utf8");

    const result = new ReleaseActivator().activate({
      paths: fixture.paths, environment: {}, identity: fixture.identity, candidateValue: fixture.candidate,
      writeUnits: () => writeUnits(fixture.paths, "candidate unit\n"),
      runSystemd: (args, tolerateFailure) => {
        const operation = args.at(1) ?? "unknown";
        calls.push(`${operation}:${tolerateFailure === true ? "tolerated" : "strict"}`);
        return operation === "daemon-reload" && tolerateFailure !== true ? 7 : 0;
      },
      readEnabledState: () => "enabled",
      writeStdout: () => undefined,
      writeStderr: () => undefined
    });

    expect(result).toBe(7);
    expect(realpathSync(fixture.paths.currentLink)).toBe(fixture.previous);
    expect(readFileSync(fixture.paths.unitFile, "utf8")).toBe(priorUnit);
    expect(calls).toEqual(["daemon-reload:strict", "daemon-reload:tolerated", "enable:tolerated"]);
    expect(existsSync(fixture.paths.activationMarker)).toBe(false);
  });
});

function createFixture(withPrevious = false): {
  paths: ReleaseActivationPaths; identity: BuildIdentity; candidate: string; previous: string;
} {
  const state = mkdtempSync(join(tmpdir(), "release-activator-"));
  const releasesDirectory = join(state, "releases");
  const units = join(state, "units");
  mkdirSync(releasesDirectory);
  mkdirSync(units);
  const hash = "a".repeat(64);
  const commit = "b".repeat(40);
  const candidate = join(releasesDirectory, `${hash}-${commit.slice(0, 12)}`);
  const previous = join(releasesDirectory, `${"c".repeat(64)}-${"d".repeat(12)}`);
  mkdirSync(candidate);
  const paths: ReleaseActivationPaths = {
    root: candidate, releasesDirectory, currentLink: join(state, "current"),
    activationMarker: join(state, ".release-activation.json"),
    activationUnitBackup: join(state, ".release-activation.unit"),
    activationRotationUnitBackup: join(state, ".release-activation.rotation-unit"),
    activationRotationTimerBackup: join(state, ".release-activation.rotation-timer"),
    unitFile: join(units, "herdr-agent-swarm.service"),
    rotationUnitFile: join(units, "herdr-agent-swarm-log-rotate.service"),
    rotationTimerFile: join(units, "herdr-agent-swarm-log-rotate.timer"),
    serviceName: "herdr-agent-swarm.service"
  };
  if (withPrevious) {
    mkdirSync(previous);
    symlinkSync(previous, paths.currentLink);
    writeUnits(paths, "previous unit\n");
  }
  return {
    paths, candidate, previous,
    identity: { serviceId: "herdr-agent-swarm", version: "0.4.0", buildId: `sha256:${hash}`, gitCommit: commit }
  };
}

function writeUnits(paths: ReleaseActivationPaths, service: string): void {
  writeFileSync(paths.unitFile, service, { mode: 0o640 });
  writeFileSync(paths.rotationUnitFile, "rotation unit\n", { mode: 0o640 });
  writeFileSync(paths.rotationTimerFile, "rotation timer\n", { mode: 0o640 });
}
