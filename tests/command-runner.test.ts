import { describe, expect, it } from "vitest";
import { CommandError } from "../src/infra/command-runner.js";

describe("command error redaction", () => {
  it("never exposes pane send-text content through error fields", () => {
    const secret = "private user prompt";
    const error = new CommandError("herdr", ["pane", "send-text", "w1:p1", secret], `failed to send ${secret}`, false);

    expect(error.args).toEqual(["pane", "send-text", "w1:p1", "[REDACTED]"]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
