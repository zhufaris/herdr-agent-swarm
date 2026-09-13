import { describe, expect, it } from "vitest";
import { CommandError, ExecFileCommandRunner } from "../src/infra/command-runner.js";

describe("command error redaction", () => {
  it("reports process start before waiting for command completion", async () => {
    let started = false;
    const result = await new ExecFileCommandRunner(1000).run(process.execPath, ["-e", "setTimeout(() => {}, 10)"], undefined, () => { started = true; });
    expect(started).toBe(true);
    expect(result.stdout).toBe("");
  });

  it("does not report command completion before the dispatch receipt is durable", async () => {
    let releaseReceipt: (() => void) | undefined;
    let completed = false;
    const receipt = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const command = new ExecFileCommandRunner(1000)
      .run(process.execPath, ["-e", ""], undefined, () => receipt)
      .then(() => { completed = true; });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);
    releaseReceipt?.();
    await command;
    expect(completed).toBe(true);
  });

  it("does not report dispatch when the process cannot spawn", async () => {
    let started = false;
    await expect(new ExecFileCommandRunner(1000).run("/definitely/missing/herdr", [], undefined, () => { started = true; })).rejects.toThrow();
    expect(started).toBe(false);
  });

  it("terminates the exact running child when its abort signal fires", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const command = new ExecFileCommandRunner(30_000).run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      undefined,
      started,
      controller.signal
    );

    await didStart;
    controller.abort(new Error("shutdown"));

    await expect(command).rejects.toThrow();
  });
  it("never exposes agent prompt content through error fields", () => {
    const secret = "private Lark prompt";
    const error = new CommandError("herdr", ["agent", "prompt", "w1:p1", secret], `failed to submit ${secret}`, false);

    expect(error.args).toEqual(["agent", "prompt", "w1:p1", "[REDACTED]"]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("never exposes the Primary tool capability from pane environment arguments", () => {
    const capability = "b".repeat(64);
    const environment = "SWARM_PRIMARY_CAPABILITY=" + capability;
    const error = new CommandError("herdr", ["tab", "create", "--env", environment], "failed with " + environment + " and " + capability, false);

    expect(error.args).toEqual(["tab", "create", "--env", "SWARM_PRIMARY_CAPABILITY=[REDACTED]"]);
    expect(error.message).not.toContain(capability);
    expect(JSON.stringify(error)).not.toContain(capability);
  });
});
