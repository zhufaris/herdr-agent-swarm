import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OwnedTraexChoicePluginActivation,
  uninstallOwnedTraexChoicePlugin,
  type TraexPluginCommandRunner
} from "../src/cli/service-lifecycle/owned-traex-choice-plugin.js";

describe("OwnedTraexChoicePluginActivation", () => {
  it("validates before mutation, installs and enables the exact owned plugin, then writes private compatible data", () => {
    const fixture = setup();
    const transaction = new OwnedTraexChoicePluginActivation(fixture.options);

    transaction.activate();

    expect(fixture.calls).toEqual([
      ["plugin", "validate", "--path", fixture.pluginRoot],
      ["plugin", "validate", "herdr-choice-list"],
      ["plugin", "install", fixture.pluginRoot, "--type", "local", "--name", "herdr-choice-list", "--yes"],
      ["plugin", "enable", "herdr-choice-list"],
      ["plugin", "validate", "herdr-choice-list"]
    ]);
    expect(JSON.parse(readFileSync(fixture.activationPath, "utf8"))).toEqual({
      schemaVersion: 1,
      pluginName: "herdr-choice-list",
      pluginVersion: "1.0.0",
      buildId: "sha256:candidate",
      sourcePath: fixture.pluginRoot,
      helperPath: join(fixture.releaseRoot, "dist/cli/completion-choice-stop-hook.js"),
      socketPath: join(fixture.stateDirectory, "completion-choice-eligibility.sock")
    });
    expect(statSync(fixture.activationPath).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an installed same-name plugin without an owned activation record", () => {
    const fixture = setup({ installed: true });
    const transaction = new OwnedTraexChoicePluginActivation(fixture.options);

    expect(() => transaction.activate()).toThrow(/not owned/);
    expect(fixture.calls).toEqual([
      ["plugin", "validate", "--path", fixture.pluginRoot],
      ["plugin", "validate", "herdr-choice-list"]
    ]);
  });

  it("re-applies the same owned release idempotently", () => {
    const fixture = setup();
    new OwnedTraexChoicePluginActivation(fixture.options).activate();
    const before = readFileSync(fixture.activationPath, "utf8");

    new OwnedTraexChoicePluginActivation(fixture.options).activate();

    expect(readFileSync(fixture.activationPath, "utf8")).toBe(before);
    expect(fixture.calls.slice(-4)).toEqual([
      ["plugin", "validate", "--path", fixture.pluginRoot],
      ["plugin", "install", fixture.pluginRoot, "--type", "local", "--name", "herdr-choice-list", "--yes"],
      ["plugin", "enable", "herdr-choice-list"],
      ["plugin", "validate", "herdr-choice-list"]
    ]);
  });

  it("restores the previous release plugin and activation data after a later activation failure", () => {
    const fixture = setup({ previous: true });
    const before = readFileSync(fixture.activationPath, "utf8");
    const transaction = new OwnedTraexChoicePluginActivation(fixture.options);
    transaction.activate();
    transaction.rollback();

    expect(readFileSync(fixture.activationPath, "utf8")).toBe(before);
    expect(fixture.calls.slice(-4)).toEqual([
      ["plugin", "validate", "--path", fixture.previousPluginRoot],
      ["plugin", "install", fixture.previousPluginRoot, "--type", "local", "--name", "herdr-choice-list", "--yes"],
      ["plugin", "enable", "herdr-choice-list"],
      ["plugin", "validate", "herdr-choice-list"]
    ]);
  });

  it("compensates a partial first install by removing only the exact owned plugin and data", () => {
    const fixture = setup({ failEnable: true });
    const transaction = new OwnedTraexChoicePluginActivation(fixture.options);
    expect(() => transaction.activate()).toThrow(/enable/);
    transaction.rollback();

    expect(fixture.calls.at(-1)).toEqual(["plugin", "uninstall", "herdr-choice-list"]);
    expect(existsSync(fixture.activationPath)).toBe(false);
  });

  it("uninstalls only when a valid owned record exists and preserves unrelated plugin data", () => {
    const fixture = setup({ previous: true });
    const unrelated = join(fixture.pluginDataDirectory, "unrelated");
    writeFileSync(unrelated, "preserve\n");

    expect(uninstallOwnedTraexChoicePlugin(fixture.options)).toBe(0);
    expect(fixture.calls).toEqual([["plugin", "uninstall", "herdr-choice-list"]]);
    expect(existsSync(fixture.activationPath)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("preserve\n");
  });
});

function setup(options: { installed?: boolean; previous?: boolean; failEnable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owned-choice-plugin-"));
  const stateDirectory = join(root, "state");
  const traeHome = join(root, "trae");
  const releaseRoot = join(root, "candidate");
  const previousRoot = join(root, "previous");
  const pluginRoot = createRelease(releaseRoot);
  const previousPluginRoot = createRelease(previousRoot);
  const pluginDataDirectory = join(traeHome, "plugins/data/herdr-choice-list");
  const activationPath = join(pluginDataDirectory, "activation.json");
  mkdirSync(stateDirectory, { recursive: true });
  if (options.previous) {
    mkdirSync(pluginDataDirectory, { recursive: true });
    writeFileSync(activationPath, JSON.stringify({
      schemaVersion: 1, pluginName: "herdr-choice-list", pluginVersion: "1.0.0", buildId: "sha256:previous",
      sourcePath: previousPluginRoot, helperPath: join(previousRoot, "dist/cli/completion-choice-stop-hook.js"),
      socketPath: join(stateDirectory, "completion-choice-eligibility.sock")
    }) + "\n", { mode: 0o600 });
  }
  const calls: string[][] = [];
  const run: TraexPluginCommandRunner = (args) => {
    calls.push([...args]);
    if (args.join(" ") === "plugin validate herdr-choice-list") return options.installed || options.previous || calls.some((call) => call[1] === "install") ? 0 : 1;
    if (options.failEnable && args.join(" ") === "plugin enable herdr-choice-list") return 9;
    return 0;
  };
  return {
    root, stateDirectory, traeHome, releaseRoot, previousRoot, pluginRoot, previousPluginRoot,
    pluginDataDirectory, activationPath, calls,
    options: { releaseRoot, stateDirectory, traeHome, buildId: "sha256:candidate", run }
  };
}

function createRelease(root: string): string {
  const pluginRoot = join(root, "plugins/herdr-choice-list");
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
  mkdirSync(join(pluginRoot, "skills/herdr-choice-list"), { recursive: true });
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist/cli"), { recursive: true });
  writeFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name: "herdr-choice-list", version: "1.0.0" }));
  writeFileSync(join(pluginRoot, "hooks/hooks.json"), "{}\n");
  writeFileSync(join(pluginRoot, "skills/herdr-choice-list/SKILL.md"), "# Choice protocol\n");
  writeFileSync(join(pluginRoot, "scripts/herdr-choice-stop-hook.mjs"), "// wrapper\n");
  writeFileSync(join(root, "dist/cli/completion-choice-stop-hook.js"), "// helper\n");
  return pluginRoot;
}
