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

  it("never exposes versioned Agent Input content through error fields", () => {
    const secret = "private independent Lark input";
    const error = new CommandError(
      "herdr",
      ["agent", "input", "w1:p1", secret, "--submission-id", "input-1"],
      `failed to submit ${secret}`,
      false
    );

    expect(error.args).toEqual([
      "agent", "input", "w1:p1", "[REDACTED]", "--submission-id", "input-1"
    ]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("never exposes typed Agent Input v4 content through error fields", () => {
    const secret = "private typed Lark input";
    const error = new CommandError(
      "herdr",
      [
        "agent", "input-v4", "w1:p1", secret,
        "--submission-id", "input-1",
        "--action-set-id", "actions-1",
        "--option-id", "approve",
        "--source-message-id", "message-1"
      ],
      `failed to submit ${secret}`,
      false
    );

    expect(error.args).toEqual([
      "agent", "input-v4", "w1:p1", "[REDACTED]",
      "--submission-id", "input-1",
      "--action-set-id", "actions-1",
      "--option-id", "approve",
      "--source-message-id", "message-1"
    ]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("never retains typed Agent Input v4 content in the underlying process error", async () => {
    const secret = "private typed Lark input in process cause";
    let observed: unknown;

    try {
      await new ExecFileCommandRunner(1000).run(process.execPath, [
        "agent", "input-v4", "w1:p1", secret,
        "--submission-id", "input-1"
      ]);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(CommandError);
    const cause = (observed as Error & { cause?: { message?: unknown; cmd?: unknown } }).cause;
    expect(String(cause?.message ?? "")).not.toContain(secret);
    expect(String(cause?.cmd ?? "")).not.toContain(secret);
  });

  it("never exposes the Primary tool capability from pane environment arguments", () => {
    const capability = "b".repeat(64);
    const environment = "SWARM_PRIMARY_CAPABILITY=" + capability;
    const error = new CommandError("herdr", ["tab", "create", "--env", environment], "failed with " + environment + " and " + capability, false);

    expect(error.args).toEqual(["tab", "create", "--env", "SWARM_PRIMARY_CAPABILITY=[REDACTED]"]);
    expect(error.message).not.toContain(capability);
    expect(JSON.stringify(error)).not.toContain(capability);
  });

  it("never exposes managed Agent launch arguments through command errors", () => {
    const secret = "secret-launch-argument";
    const error = new CommandError(
      "herdr",
      ["agent", "session-rotate", "--operation-id", "clear-1", "--", "--resume-token", secret],
      `failed to launch --resume-token ${secret}`,
      true
    );

    expect(error.args).toEqual([
      "agent", "session-rotate", "--operation-id", "clear-1", "--", "[REDACTED]", "[REDACTED]"
    ]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
