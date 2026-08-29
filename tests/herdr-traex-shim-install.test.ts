import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Herdr TraeX shim installer", () => {
  it("requires an explicit absolute bin directory", async () => {
    const fixture = await createFixture();
    const result = await install(fixture, ["install"], { HERDR_TRAEX_SHIM_BIN_DIR: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/absolute.*bin directory/i);
  });

  it("installs atomically ahead of the real binary and reports status", async () => {
    const fixture = await createFixture();
    const result = await install(fixture, ["install"]);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(await lstat(join(fixture.shimBin, "herdr"))).toMatchObject({});
    expect(await readlink(join(fixture.shimBin, "herdr"))).toMatch(/releases\/[^/]+\/herdr$/);
    const config = JSON.parse(await readFile(join(fixture.config, "herdr-traex-shim/config.json"), "utf8"));
    expect(config).toMatchObject({
      realHerdr: fixture.realHerdr, traex: fixture.traex, validatedHerdrVersion: "0.7.5", binDir: fixture.shimBin,
      launcher: expect.stringMatching(/releases\/[^/]+\/pane-launcher$/),
      reporter: expect.stringMatching(/releases\/[^/]+\/cli\/herdr-traex-reporter\.js$/),
      requestDir: join(fixture.runtime, "herdr-traex-shim/run")
    });
    expect(await readFile(join(config.releaseDir, "cli/report-traex-lifecycle.js"), "utf8")).toContain("export");
    expect(await readFile(join(config.releaseDir, "runtime/report-traex-lifecycle.js"), "utf8")).toContain("export");

    const status = await install(fixture, ["status"]);
    expect(status).toMatchObject({ code: 0 });
    expect(status.stdout).toContain("status: ready");
    expect(status.stdout).toContain("herdr: 0.7.5");
  });

  it("rejects Herdr without native Agent session reporting", async () => {
    const fixture = await createFixture({ missingAgentSession: true });
    const result = await install(fixture, ["install"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/agent-session-id/);
  });

  it("refuses unsafe PATH order and preserves an unrelated target", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.shimBin, "herdr"), "keep me");
    const unrelated = await install(fixture, ["install"]);
    expect(unrelated.code).toBe(1);
    expect(await readFile(join(fixture.shimBin, "herdr"), "utf8")).toBe("keep me");

    const after = await createFixture({ shimAfterReal: true });
    const unsafePath = await install(after, ["install"]);
    expect(unsafePath.code).toBe(1);
    expect(unsafePath.stderr).toMatch(/precede.*real Herdr/i);
  });

  it("uninstalls only shim-owned state and never deletes the real binary", async () => {
    const fixture = await createFixture();
    const installed = await install(fixture, ["install"]);
    expect(installed, installed.stderr).toMatchObject({ code: 0 });
    expect((await install(fixture, ["uninstall"])).code).toBe(0);
    await expect(lstat(join(fixture.shimBin, "herdr"))).rejects.toThrow();
    expect(await readFile(fixture.realHerdr, "utf8")).toContain("0.7.5");
  });

  it("warns while delegating after a Herdr upgrade but refuses TraeX start", async () => {
    const fixture = await createFixture();
    expect((await install(fixture, ["install"])).code).toBe(0);
    await executable(fixture.realHerdr, [
      "#!/usr/bin/env bash",
      "if [[ $1 == --version ]]; then echo 'herdr 0.8.0'; else printf '%s\n' \"$@\"; fi",
      ""
    ].join("\n"));
    const delegated = await execute(join(fixture.shimBin, "herdr"), ["agent", "list"], fixture.path);
    expect(delegated.code).toBe(0);
    expect(delegated.stderr).toMatch(/version mismatch/i);
    const start = await execute(join(fixture.shimBin, "herdr"), ["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"], fixture.path);
    expect(start.code).toBe(1);
    expect(start.stderr).toMatch(/not validated/i);
  });
});

interface Fixture { root: string; home: string; data: string; config: string; state: string; runtime: string; shimBin: string; realBin: string; realHerdr: string; traex: string; source: string; path: string }

async function createFixture(options: { shimAfterReal?: boolean; missingAgentSession?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "herdr-traex-install-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const config = join(root, "config");
  const state = join(root, "state");
  const runtime = join(root, "runtime");
  const shimBin = join(root, "shim-bin");
  const realBin = join(root, "real-bin");
  const source = join(root, "source");
  await Promise.all([home, data, config, state, runtime, shimBin, realBin, join(source, "dist/cli"), join(source, "dist/runtime"), join(source, "scripts")].map((path) => mkdir(path, { recursive: true })));
  const realHerdr = join(realBin, "herdr");
  const traex = join(realBin, "traex");
  await executable(realHerdr, [
    "#!/usr/bin/env bash",
    "if [[ $1 == --version ]]; then echo 'herdr 0.7.5'",
    `elif [[ $1 == pane && $2 == report-agent && $3 == --help ]]; then echo '${options.missingAgentSession ? "Usage: report-agent" : "Usage: report-agent --agent-session-id <ID>"}'`,
    "else echo '{\"methods\":[\"pane.report_agent\",\"pane.report_metadata\",\"pane.release_agent\"]}'",
    "fi",
    ""
  ].join("\n"));
  await executable(traex, '#!/usr/bin/env bash\necho "traex 0.201.6"\n');
  for (const file of ["herdr-traex-shim.js", "herdr-traex-reporter.js", "report-traex-lifecycle.js"]) await writeFile(join(source, "dist/cli", file), "export {};\n");
  for (const file of ["herdr-traex-shim.js", "herdr-traex-reporter.js", "report-traex-lifecycle.js"]) await writeFile(join(source, "dist/runtime", file), "export {};\n");
  const repo = process.cwd();
  await writeFile(join(source, "scripts/herdr-traex-command-shim.sh"), await readFile(join(repo, "scripts/herdr-traex-command-shim.sh")));
  await writeFile(join(source, "scripts/herdr-traex-pane-launcher.sh"), await readFile(join(repo, "scripts/herdr-traex-pane-launcher.sh")));
  const path = options.shimAfterReal ? `${realBin}:${shimBin}:/usr/bin:/bin` : `${shimBin}:${realBin}:/usr/bin:/bin`;
  return { root, home, data, config, state, runtime, shimBin, realBin, realHerdr, traex, source, path };
}

async function executable(path: string, content: string): Promise<void> { await writeFile(path, content); await chmod(path, 0o755); }

async function install(fixture: Fixture, args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile("bash", [join(process.cwd(), "scripts/install-herdr-traex-shim.sh"), ...args], {
    cwd: fixture.source, env: { ...process.env, HOME: fixture.home, XDG_DATA_HOME: fixture.data, XDG_CONFIG_HOME: fixture.config, XDG_STATE_HOME: fixture.state, XDG_RUNTIME_DIR: fixture.runtime, PATH: fixture.path, HERDR_TRAEX_SHIM_BIN_DIR: fixture.shimBin, HERDR_TRAEX_REAL_HERDR: fixture.realHerdr, HERDR_TRAEX_BIN: fixture.traex, HERDR_TRAEX_SHIM_SOURCE_ROOT: fixture.source, HERDR_TRAEX_SKIP_BUILD: "1", ...overrides }
  }, (error, stdout, stderr) => resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : 0, stdout, stderr })));
}

async function execute(executable: string, args: string[], path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(executable, args, { env: { ...process.env, PATH: path } }, (error, stdout, stderr) => resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : 0, stdout, stderr })));
}
