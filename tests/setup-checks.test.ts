import { describe, expect, it } from "vitest";
import { evaluateSetupChecks, runLocalSetupChecks } from "../src/setup/setup-checks.js";

describe("setup check policy", () => {
  it("blocks saving and startup on failure", () => {
    expect(evaluateSetupChecks([{ id: "lark.auth", status: "fail", summary: "unauthorized" }]))
      .toEqual({ canSave: false, canStart: false, hasWarnings: false, hasSkipped: false });
  });

  it("allows saving but blocks startup after an explicit skip", () => {
    expect(evaluateSetupChecks([{ id: "lark.chat", status: "skipped", summary: "skipped by operator" }]))
      .toEqual({ canSave: true, canStart: false, hasWarnings: false, hasSkipped: true });
  });

  it("allows warnings while retaining them for review", () => {
    expect(evaluateSetupChecks([{ id: "lark.bot", status: "warning", summary: "verify manually" }]))
      .toEqual({ canSave: true, canStart: true, hasWarnings: true, hasSkipped: false });
  });

  it("checks only runtime executables, not removed instance templates", async () => {
    const resolved: string[] = [];
    await runLocalSetupChecks({
      environment: { HERDR_BIN: "herdr", TRAEX_BIN: "traex", CODEX_BIN: "codex" },
      registry: {
        defaultProjectId: "demo",
        projects: [{ id: "demo", displayName: "Demo", description: "Demo", workspaceId: "w1", cwd: "/repo" }]
      }
    }, { root: "/app", configDirectory: "/config", stateDirectory: "/state", serviceName: "swarm.service", cwd: "/repo" }, {
      nodeVersion: "22.12.0",
      runner: { async run() { return { stdout: "", stderr: "" }; } },
      resolveExecutable(executable) { resolved.push(executable); return `/bin/${executable}`; },
      async inspectDirectoryMode() { return 0o700; },
      async inspectPort() { return "free"; }
    });

    expect(resolved).toEqual(["herdr", "traex"]);
  });
});
