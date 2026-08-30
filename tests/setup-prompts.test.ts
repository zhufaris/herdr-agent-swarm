import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SetupCancelledError, TerminalSetupPrompts } from "../src/setup/setup-prompts.js";

class FakeInput extends PassThrough {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(value: boolean) { this.rawModes.push(value); return this; }
}

describe("terminal setup prompts", () => {
  it("reads a secret without echoing bytes and restores raw mode", async () => {
    const input = new FakeInput();
    const output = new PassThrough();
    let rendered = ""; output.on("data", (chunk) => { rendered += chunk.toString(); });
    const prompts = new TerminalSetupPrompts({ input, output });
    const pending = prompts.secret("Secret", false);
    input.write("top-secret\r");
    await expect(pending).resolves.toEqual({ action: "replace", value: "top-secret" });
    expect(rendered).toContain("Secret");
    expect(rendered).not.toContain("top-secret");
    expect(input.rawModes).toEqual([true, false]);
  });

  it("turns Ctrl-C and Escape into cancellation and restores raw mode", async () => {
    for (const byte of ["\u0003", "\u001b"]) {
      const input = new FakeInput();
      const prompts = new TerminalSetupPrompts({ input, output: new PassThrough() });
      const pending = prompts.secret("Secret", false);
      input.write(byte);
      await expect(pending).rejects.toBeInstanceOf(SetupCancelledError);
      expect(input.rawModes).toEqual([true, false]);
    }
  });

  it("rejects hidden input on a non-TTY", async () => {
    const input = new FakeInput(); input.isTTY = false;
    await expect(new TerminalSetupPrompts({ input, output: new PassThrough() }).secret("Secret", false)).rejects.toThrow(/TTY/);
    expect(input.rawModes).toEqual([]);
  });
});
